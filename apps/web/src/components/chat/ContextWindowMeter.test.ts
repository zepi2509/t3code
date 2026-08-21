import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { hasAvailableCompactionProvider } from "./ContextWindowMeter.logic";

const piInstanceId = ProviderInstanceId.make("pi");

function piProvider(supportsCompact: boolean): ServerProvider {
  return {
    instanceId: piInstanceId,
    driver: ProviderDriverKind.make("pi"),
    continuation: { groupKey: "pi:default" },
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-08-24T12:00:00.000Z",
    models: [],
    slashCommands: supportsCompact ? [{ name: "compact", description: "" }] : [],
    skills: [],
  };
}

describe("Pi manual context compaction", () => {
  it("uses the selected provider's advertised slash commands", () => {
    const available = (supportsCompact: boolean) =>
      hasAvailableCompactionProvider({
        providers: deriveProviderInstanceEntries([piProvider(supportsCompact)]),
        driverKind: ProviderDriverKind.make("pi"),
        instanceId: piInstanceId,
        lockedInstanceId: piInstanceId,
      });

    expect(available(true)).toBe(true);
    expect(available(false)).toBe(false);
  });
});
