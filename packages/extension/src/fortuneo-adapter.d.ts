import type { FortuneoSnapshot } from "../../shared/src/model.js";

export function adaptFortuneo(payloads: Array<{ path: string; data: unknown }>): FortuneoSnapshot;
