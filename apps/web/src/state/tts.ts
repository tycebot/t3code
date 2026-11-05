import { WS_METHODS } from "@t3tools/contracts";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

// Speech synthesis runs where the TTS engine lives — the environment's
// server — so the request travels over that environment's own RPC
// connection. That keeps remote and desktop setups pointed at the right
// origin without the browser guessing URLs.
export const ttsSynthesize = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:tts:synthesize",
  tag: WS_METHODS.ttsSynthesize,
});
