import { ClawpatchError } from "./errors.js";
import { providerExitCode } from "./provider-errors.js";
import { providerJsonSchema } from "./provider-schema.js";
import type { Provider } from "./provider-types.js";
import { acpxProvider, acpxTesting } from "./providers/acpx.js";
import { claudeProvider, claudeTesting } from "./providers/claude.js";
import { codexProvider, codexTesting } from "./providers/codex.js";
import { cursorProvider, cursorTesting } from "./providers/cursor.js";
import { devinProvider, devinTesting } from "./providers/devin.js";
import { grokProvider } from "./providers/grok.js";
import { mockFailProvider, mockProvider } from "./providers/mock.js";
import { opencodeProvider, opencodeTesting } from "./providers/opencode.js";
import { piProvider, piTesting } from "./providers/pi.js";

export { extractJson } from "./provider-json.js";

const providers: Readonly<Record<string, Provider>> = {
  acpx: acpxProvider,
  claude: claudeProvider,
  codex: codexProvider,
  cursor: cursorProvider,
  devin: devinProvider,
  grok: grokProvider,
  mock: mockProvider,
  "mock-fail": mockFailProvider,
  opencode: opencodeProvider,
  pi: piProvider,
};

export function providerByName(name: string): Provider {
  const provider = providers[name];
  if (provider !== undefined) {
    return provider;
  }
  throw new ClawpatchError(`unsupported provider: ${name}`, 2, "unsupported-provider");
}

// eslint-disable-next-line no-underscore-dangle
export const __testing = {
  ...acpxTesting,
  ...claudeTesting,
  ...codexTesting,
  ...cursorTesting,
  ...devinTesting,
  ...opencodeTesting,
  ...piTesting,
  providerExitCode,
  providerJsonSchema,
};
