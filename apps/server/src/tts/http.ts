import { EnvironmentHttpApi, EnvironmentInternalError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as Layer from "effect/Layer";

import { annotateEnvironmentRequest, currentEnvironmentTraceId } from "../auth/http.ts";
import * as TtsService from "./TtsService.ts";

const groupLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "tts",
  Effect.fnUntraced(function* (handlers) {
    const tts = yield* TtsService.TtsService;
    return handlers.handle(
      "synthesize",
      Effect.fn("environment.tts.synthesize")(function* (args) {
        yield* annotateEnvironmentRequest(args.endpoint.name);
        const traceId = yield* currentEnvironmentTraceId;
        return yield* tts.synthesize(args.payload.text).pipe(
          Effect.mapError(
            () =>
              new EnvironmentInternalError({
                code: "internal_error",
                reason: "internal_error",
                traceId,
              }),
          ),
        );
      }),
    );
  }),
);

export const serviceLayer = groupLayer.pipe(Layer.provide(TtsService.layer));
