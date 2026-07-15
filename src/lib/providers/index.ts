import type { ChannelProviderConfig, ProviderId } from "./types";
import { gmail } from "./gmail";
import { outlook } from "./outlook";
import { linkedin } from "./linkedin";
import { x } from "./x";
import { whatsapp } from "./whatsapp";
import { sms } from "./sms";
import { asana } from "./asana";

export const providers: Record<ProviderId, ChannelProviderConfig> = {
  gmail,
  outlook,
  linkedin,
  x,
  whatsapp,
  sms,
  asana,
};

export function getProvider(id: string): ChannelProviderConfig | undefined {
  return providers[id as ProviderId];
}

export * from "./types";
