import {
  FortiOSDriver,
  FortiOSFirewallAddrGrp,
  FortiOSFirewallAddrGrp6,
  FortiOSFirewallAddress,
  NAMFortiOSVdom,
  NAMRorIntegrator,
  isDevMode,
} from "@norskhelsenett/zeniki";
import logger from "../loggers/logger.ts";

export const deployAddresses = async (
  firewall: FortiOSDriver,
  vdom: NAMFortiOSVdom,
  integrator: NAMRorIntegrator,
  addresses: FortiOSFirewallAddress[]
) => {
  try {
    const [fgAddressGroups, fgAddresses] = await Promise.all([
      firewall
        .getAddressGroups({ vdom: vdom.name })
        .then((res) => res?.results as FortiOSFirewallAddrGrp[] | undefined)
        .catch((error: unknown) => {
          logger.warning(
            `ror-firewall-ssi: Failed getting IPv4 address groups from '${
              integrator.name
            }' on '${firewall.getHostname()}' vdom '${vdom.name}'`,
            {
              component: "fortios.service",
              method: "deployAddresses",
              error: isDevMode() ? error : (error as Error).message,
            }
          );
          return undefined;
        }),
      firewall
        .getAddresses({ vdom: vdom.name })
        .then((res) => res?.results as FortiOSFirewallAddress[] | undefined)
        .catch((error: unknown) => {
          logger.warning(
            `ror-firewall-ssi: Failed getting IPv4 addresses from '${
              integrator.name
            }' on '${firewall.getHostname()}' vdom '${vdom.name}'`,
            {
              component: "fortios.service",
              method: "deployAddresses",
              error: isDevMode() ? error : (error as Error).message,
            }
          );
          return undefined;
        }),
    ]);

    if (fgAddresses && fgAddressGroups) {
      for (const address of addresses) {
        // create ipv4 addresses on Fortios if they do not already exist
        if (
          !fgAddresses.some((fortigateAddress: FortiOSFirewallAddress) => {
            return fortigateAddress.name === address.name;
          })
        ) {
          await firewall
            .addAddress(address, { vdom: vdom.name })
            .then((_res) => {
              logger.info(
                `ror-firewall-ssi: Created IPv4 address '${
                  address.name
                }' from '${
                  integrator.name
                }' on '${firewall.getHostname()}' vdom '${vdom.name}'`
              );
            })
            .catch((error: unknown) => {
              logger.error(
                `ror-firewall-ssi: Failed to create IPv4 address '${
                  address.name
                }' from '${
                  integrator.name
                }' on '${firewall.getHostname()}' vdom '${vdom.name}'`,
                {
                  component: "fortios.service",
                  method: "deployAddresses",
                  error: isDevMode() ? error : (error as Error).message,
                }
              );
            });
        }
      }

      const groupName = "grp_" + integrator.fg_group_name;

      if (
        fgAddressGroups &&
        !fgAddressGroups.some((addrGrp: FortiOSFirewallAddrGrp) => {
          return addrGrp.name === groupName;
        })
      ) {
        const meta = {
          name: groupName,
          type: "CREATE",
          src: {
            system: "ror",
            server: integrator.ror_endpoint.name,
            options: {
              scope: "CPEP",
              tag: "!prod && !mgmt",
            },
          },
          dst: {
            system: "fortigate",
            server: firewall.getHostname(),
            options: { vdom: vdom.name },
          },
          updates: {
            added: addresses.map((address: FortiOSFirewallAddress) => {
              return address.name;
            }),
            removed: [],
          },
        };

        await firewall
          .addAddressGroup(
            {
              name: groupName,
              comment: "Managed by NAM",
              color: 3,
              member: addresses.map((address: FortiOSFirewallAddress) => {
                return { name: address.name };
              }),
            },
            { vdom: vdom.name }
          )
          .then((_res) => {
            logger.info(
              `ror-firewall-ssi: Created IPv4 address group from '${
                integrator.name
              }' on '${firewall.getHostname()}' vdom '${vdom.name}'`,
              {
                component: "fortios.service",
                method: "deployAddresses",
                ...meta,
              }
            );
          })
          .catch((error: unknown) => {
            logger.error(
              `ror-firewall-ssi: Creation of IPv4 address group failed from '${
                integrator.name
              }' on '${firewall.getHostname()}' vdom '${vdom.name}'`,
              {
                component: "fortios.service",
                method: "deployAddresses",
                ...meta,
                error: isDevMode() ? error : (error as Error).message,
              }
            );
          });
      } else {
        const fortigateIpv4AddressGroup = fgAddressGroups?.find(
          (addressGroup: FortiOSFirewallAddrGrp) => {
            return addressGroup.name === groupName;
          }
        ) as FortiOSFirewallAddrGrp;

        //Find members only present in ROR
        const added = addresses.filter(
          (rorAddress: FortiOSFirewallAddress) =>
            !fortigateIpv4AddressGroup.member.some(
              (fortigateMember: { name: string }) =>
                fortigateMember.name === rorAddress.name
            )
        );

        //Find members only present in Fortigate
        const deleted = fortigateIpv4AddressGroup.member.filter(
          (fortigateMember: { name: string }) =>
            !addresses.some(
              (rorAddress: FortiOSFirewallAddress) =>
                rorAddress.name === fortigateMember.name
            )
        );

        if (added.length > 0 || deleted.length > 0) {
          const meta = {
            name: groupName,
            type: "UPDATE",
            src: {
              system: "ror",
              server: integrator.ror_endpoint.name,
              options: {
                scope: "CPEP",
                tag: "!prod && !mgmt",
              },
            },
            dst: {
              system: "fortigate",
              server: firewall.getHostname(),
              options: { vdom: vdom.name },
            },
            updates: {
              added: added.map((address: FortiOSFirewallAddress) => {
                return address.name;
              }),
              removed: deleted.map((address: { name: string }) => {
                return address.name;
              }),
            },
          };

          await firewall
            .updateAddressGroup(
              groupName,
              {
                name: groupName,
                comment: "Managed by NAM",
                color: fortigateIpv4AddressGroup.color,
                member: addresses.map((address: FortiOSFirewallAddress) => {
                  return { name: address.name };
                }),
              },
              { vdom: vdom.name }
            )
            .then((_res) => {
              logger.info(
                `ror-firewall-ssi: Updated IPv4 address group from '${
                  integrator.name
                }' on '${firewall.getHostname()}' vdom '${vdom.name}'`,
                {
                  component: "fortios.service",
                  method: "deployAddresses",
                  ...meta,
                }
              );
            })
            .catch((error: unknown) => {
              logger.error(
                `ror-firewall-ssi: Updated IPv4 address group failed from '${
                  integrator.name
                }' on '${firewall.getHostname()}' vdom '${vdom.name}'`,
                {
                  component: "fortios.service",
                  method: "deployAddresses",
                  ...meta,
                  error: isDevMode() ? error : (error as Error).message,
                }
              );
            });
        }
      }
    }
  } catch (error) {
    throw error;
  }
};

export const deployAddresses6 = async (
  firewall: FortiOSDriver,
  vdom: NAMFortiOSVdom,
  integrator: NAMRorIntegrator,
  addresses: FortiOSFirewallAddress[]
) => {
  try {
    const fgAddressGroups: FortiOSFirewallAddrGrp6[] | undefined = (
      await firewall
        .getAddressGroups6({ vdom: vdom.name })
        .catch((error: unknown) => {
          logger.warning(
            `ror-firewall-ssi: Failed getting IPv6 address groups from '${
              integrator.name
            }' on '${firewall.getHostname()}' vdom '${vdom.name}'`,
            {
              component: "fortios.service",
              method: "deployAddresses",
              error: isDevMode() ? error : (error as Error).message,
            }
          );
        })
    )?.results;

    const groupName = "grp6_" + integrator.fg_group_name;

    if (
      fgAddressGroups &&
      !fgAddressGroups?.some((addrGrp: FortiOSFirewallAddrGrp6) => {
        return addrGrp.name === groupName;
      })
    ) {
      const meta = {
        name: groupName,
        type: "CREATE",
        src: {
          system: "ror",
          server: integrator.ror_endpoint.name,
          options: {
            scope: "CPEP",
            tag: "!prod && !mgmt",
          },
        },
        dst: {
          system: "fortigate",
          server: firewall.getHostname(),
          options: { vdom: vdom.name },
        },
        updates: {
          added: addresses.map((address: FortiOSFirewallAddress) => {
            return address.name;
          }),
          removed: [],
        },
      };

      await firewall
        .addAddressGroup6(
          {
            name: groupName,
            comment: "Managed by NAM",
            color: 3,
            member: [],
          },
          { vdom: vdom.name }
        )
        .then((_res) => {
          logger.info(
            `ror-firewall-ssi: Created IPv6 address group from '${
              integrator.name
            }' on '${firewall.getHostname()}' vdom '${vdom.name}'`,
            {
              component: "fortios.service",
              method: "deployAddresses6",
              ...meta,
            }
          );
        })
        .catch((error: unknown) => {
          logger.error(
            `ror-firewall-ssi: Creation of IPv6 address group failed from '${
              integrator.name
            }' on '${firewall.getHostname()}' vdom '${vdom.name}'`,
            {
              component: "fortios.service",
              method: "deployAddresses6",
              ...meta,
              error: isDevMode() ? error : (error as Error).message,
            }
          );
        });
    }
  } catch (error) {
    throw error;
  }
};
