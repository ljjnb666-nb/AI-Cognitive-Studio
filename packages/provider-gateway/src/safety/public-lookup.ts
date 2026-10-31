import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import type { LookupFunction } from "node:net";
import { ProviderGatewayError } from "../errors.js";
import { privateAddress } from "./endpoint-policy.js";

export type ProviderAddressResolver = (hostname: string) => Promise<LookupAddress[]>;
/** This lookup supplies the actual socket address. No second DNS lookup is allowed. */
export function publicProviderLookup(resolve: ProviderAddressResolver = hostname => lookup(hostname, { all: true, verbatim: true })): LookupFunction {
  return (hostname, options, callback) => {
    void resolve(hostname).then(addresses => {
      if (!addresses.length || addresses.some(item => privateAddress(item.address) || item.family !== 4 && item.family !== 6)) throw new ProviderGatewayError("NETWORK_POLICY_REJECTED");
      const family = Number(options.family) || 0;
      const candidates = family ? addresses.filter(item => item.family === family) : addresses;
      if (!candidates.length) throw new ProviderGatewayError("NETWORK_POLICY_REJECTED");
      if (options.all) callback(null, candidates);
      else callback(null, candidates[0]!.address, candidates[0]!.family);
    }).catch(error => callback(error instanceof Error ? error : new Error("PROVIDER_DNS_FAILED"), "", 4));
  };
}
