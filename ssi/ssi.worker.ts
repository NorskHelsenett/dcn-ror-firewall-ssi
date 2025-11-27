/**
 * SSI Worker - Main orchestration class for ROR-Firewall synchronization
 * Manages sync operations between ROR and FortiOS firewalls
 */

import {
  FortiOSDriver,
  FortiOSFirewallAddress,
  isDevMode,
  NAMAPIEndpoint,
  NAMv2Driver,
  RORClusterControlPlaneMetaData,
  RORv1Driver,
} from "@norskhelsenett/zeniki";
import https from "node:https";
import packageInfo from "../deno.json" with { type: "json" };
import logger from "./loggers/logger.ts";
import { NAMRorIntegrator } from "@norskhelsenett/zeniki";
import {
  deployAddresses,
  deployAddresses6,
} from "./services/fortios.service.ts";

const SSI_NAME = Deno.env.get("SSI_NAME") ?? "SSI_NAME_MISSING";
const USER_AGENT = `${SSI_NAME}/${packageInfo.version}`;
Deno.env.set("USER_AGENT", USER_AGENT);
const REQUEST_TIMEOUT = Deno.env.get("REQUEST_TIMEOUT")
  ? parseInt(Deno.env.get("REQUEST_TIMEOUT") as string)
  : 10000;

const _HTTPS_AGENT = new https.Agent({
  rejectUnauthorized: Deno.env.get("DENO_ENV")! != "development", // Set to false to disable certificate verification
  keepAlive: true,
  timeout: REQUEST_TIMEOUT,
});

const NAM_URL = Deno.env.get("NAM_URL");
const NAM_TOKEN = Deno.env.get("NAM_TOKEN");
const NAM_TEST_INT = Deno.env.get("NAM_TEST_INT");

let ranNumberOfTimes = 0;

/**
 * Main worker class that orchestrates ROR to firewall synchronization
 * Initializes API drivers and coordinates deployment to FortiGates
 */
export class SSIWorker {
  private _running: boolean = false;
  private static _nms: NAMv2Driver;
  private _firewall: FortiOSDriver | null = null;
  private _ror: RORv1Driver | null = null;

  /**
   * Initializes the worker and sets up the NAM API driver
   */
  constructor() {
    if (!SSIWorker._nms && NAM_URL) {
      SSIWorker._nms = new NAMv2Driver({
        baseURL: NAM_URL,
        headers: {
          "User-Agent": USER_AGENT,
          "Content-Type": "application/json",
          Authorization: `Bearer ${NAM_TOKEN}`,
        },
        // TODO: Figure out proper timeout, signal: AbortSignal.timeout(REQUEST_TIMEOUT),
      });
    }
  }

  get isRunning(): boolean {
    return this._running;
  }

  /**
   * Main work method that performs synchronization tasks
   * Fetches integrators, retrieves prefixes from ROR, and deploys to firewall systems
   * @param priority - Sync priority filter: low, medium, or high
   */
  public async work(priority: string = "low") {
    try {
      if (!this.isRunning) {
        this._running = true;
        logger.debug("ror-firewall-ssi: Worker running task...");

        const integrators =
          isDevMode() && NAM_TEST_INT
            ? [
                (await SSIWorker._nms.getRorIntegrator(NAM_TEST_INT, {
                  expand: 1,
                })) as NAMRorIntegrator,
              ]
            : ((
                await SSIWorker._nms.getRorIntegrators({
                  expand: 1,
                  sync_priority: priority,
                })
              )?.results as NAMRorIntegrator[]);

        for (const integrator of integrators) {
          if (!integrator?.enabled) {
            if (isDevMode() && !NAM_TEST_INT) {
              logger.debug(
                `ror-firewall-ssi: Skipping disabled integrator '${integrator?.name}'...`
              );
            }
            if (!NAM_TEST_INT) {
              continue;
            }
          }

          //   Dispose previous ROR driver if exists
          if (this._ror) {
            this._ror.dispose();
            this._ror = null;
          }
          this._ror = this._configureROR(
            integrator?.ror_endpoint as NAMAPIEndpoint
          );

          if (isDevMode()) {
            logger.debug(
              "ror-firewall-ssi: Preparing Control Plane Metadata ip addresses from ROR..."
            );
          }

          const clusterMetadata =
            (await this._ror.getControlplanesMetadata().catch((error) => {
              logger.warning(
                `ror-firewall-ssi: Could not retrieve Control Plane Metadata ip addresses from ROR '${this?._ror?.getHostname()}' due to ${
                  error.message
                } `,
                {
                  component: "ssi.worker",
                  method: "work",
                  error: isDevMode() ? error : error.message,
                }
              );
            })) || [];

          if (!clusterMetadata) {
            if (isDevMode()) {
              logger.debug(
                `ror-firewall-ssi: Skipping due to missing prefixes for '${integrator?.name}'...`
              );
            }
          }

          if (
            // integrator?.create_fg_group &&
            integrator?.fortigate_endpoints.length > 0
          ) {
            if (isDevMode()) {
              logger.debug("ror-firewall-ssi: Deploying to firewall(s)...");
            }

            const ipv4Cpeps: FortiOSFirewallAddress[] = clusterMetadata
              .filter((cluster: RORClusterControlPlaneMetaData) => {
                return (
                  cluster.datacenter &&
                  cluster.datacenter.name.includes(
                    integrator.dc.toLowerCase()
                  ) &&
                  cluster.controlPlaneEndpoint.ipv4 &&
                  !cluster.environment.includes("prod") &&
                  !cluster.environment.includes("mgmt")
                );
              })
              .map((cluster: RORClusterControlPlaneMetaData) => {
                return {
                  name: "host_k8s_cpep_" + cluster.clusterId,
                  subnet: `${cluster.controlPlaneEndpoint.ipv4} 255.255.255.255`,
                  color: 0,
                  comment: `Project: ${cluster.projectName} Cluster name: ${cluster.clusterName} Cluster ID: ${cluster.clusterId}`,
                } as FortiOSFirewallAddress;
              });

            for (const fortigate of integrator.fortigate_endpoints) {
              const firewall = fortigate.endpoint;
              const vdoms = fortigate.vdoms;

              if (!fortigate || !vdoms || vdoms.length === 0) {
                logger.warning(
                  `ror-firewall-ssi: Invalid Fortigate endpoint configured for '${integrator.name}'. Check your configuration in NAM.`
                );
                continue;
              }

              if (firewall.enabled) {
                // Dispose previous firewall driver if exists
                if (this._firewall) {
                  this._firewall.dispose();
                  this._firewall = null;
                }
                this._firewall = this._configureFirewall(firewall);

                await Promise.all(
                  vdoms.map((vdom: { name: string }) =>
                    Promise.all([
                      deployAddresses(
                        this._firewall as FortiOSDriver,
                        vdom,
                        integrator,
                        ipv4Cpeps
                      ),
                      deployAddresses6(
                        this._firewall as FortiOSDriver,
                        vdom,
                        integrator,
                        []
                      ),
                    ])
                  )
                );
              }
            }
          }
          clusterMetadata.length = 0;
        }

        // Final cleanup - clear integrators array
        if (isDevMode()) {
          logger.debug(
            `ror-firewall-ssi: Cleaning up integrators array (${integrators.length} integrators processed)`
          );
          
        }
        
        integrators.length = 0;

        this._running = false;
        this._resetDriverInstances();
        logger.debug("ror-firewall-ssi: Worker task completed...");
        console.log(
          `ror-firewall-ssi: Completed run number ${(ranNumberOfTimes += 1)}`
        );
        return 0;
      } else {
        logger.warning("ror-firewall-ssi: Worker task already running...");
        return 7;
      }
    } catch (error) {
      this._running = false;
      console.log(
        `ror-firewall-ssi: Completed run number ${(ranNumberOfTimes += 1)}`
      );
      throw error;
    }
  }

  /**
   * Configures the ROR driver with endpoint credentials
   */
  private _configureROR(endpoint: NAMAPIEndpoint): RORv1Driver {
    return new RORv1Driver({
      baseURL: endpoint.url,
      headers: {
        "User-Agent": USER_AGENT,
        "Content-Type": "application/json",
        "x-api-key": `${endpoint.key}`,
      },
      // TODO: Figure out proper timeout, signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    });
  }

  /**
   * Configures the FortiOS firewall driver with endpoint credentials
   */
  private _configureFirewall(endpoint: NAMAPIEndpoint): FortiOSDriver {
    return new FortiOSDriver({
      baseURL: endpoint.url,
      headers: {
        "User-Agent": USER_AGENT,
        "Content-Type": "application/json",
        Authorization: `Bearer ${endpoint.key}`,
      },
      // TODO: Figure out proper timeout, signal: AbortSignal.timeout(REQUEST_TIMEOUT),,
    });
  }

  private _resetDriverInstances() {
    try {
      logger.debug(`ror-firewall-ssi: Dereferencing old driver instances.`);
      if (this._firewall) {
        this._firewall.dispose();
        this._firewall = null;
      }
      if (this._ror) {
        this._ror.dispose();
        this._ror = null;
      }
    } catch (error: unknown) {
      logger.warning(
        `ror-firewall-ssi: Error could not reset one or more driver instances, ${
          (error as Error).message
        }`
      );
    }
  }
}
