import type {
  AgentMapOutput,
  CodexConfig,
  FixPlanOutput,
  ReasoningEffort,
  RevalidateOutput,
  ReviewFinding,
  reviewInspectedSchema,
} from "./types.js";
import type { z } from "zod";

export type ProviderOptions = {
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  codexConfig?: CodexConfig;
  skipGitRepoCheck: boolean;
  /**
   * Directory a provider may write diagnostics into when a call fails (the
   * gateway provider saves the full raw response of an unusable reply here).
   * Unset or null = no capture.
   */
  diagnosticsDir?: string | null;
  /**
   * Epoch ms when the first attempt of this logical call started. A provider
   * with a timeout counts it from here, so a retry shares the first attempt's
   * budget instead of getting a fresh one. Unset = this attempt starts it.
   */
  callStartedAt?: number;
  /**
   * Stable key for one logical unit of work (a feature slice), so repeat and
   * retry calls for it can land on the same backend. The gateway provider
   * sends it as `x-litellm-session-id`; the LiteLLM router's `session_affinity`
   * then pins the session to the replica that already holds its prompt prefix
   * in cache. Ignored by providers with no such notion.
   */
  sessionId?: string;
};

export type DroppedFinding = {
  path: (string | number)[];
  message: string;
  sample: string;
  layer?: "schema" | "validation" | "registry-verifier";
};

export type PartitionedReviewOutput = {
  findings: ReviewFinding[];
  inspected: z.infer<typeof reviewInspectedSchema>;
  droppedFindings: DroppedFinding[];
};

export type Provider = {
  name: string;
  check(root: string): Promise<string>;
  map(root: string, prompt: string, options: ProviderOptions): Promise<AgentMapOutput>;
  review(root: string, prompt: string, options: ProviderOptions): Promise<PartitionedReviewOutput>;
  fix(root: string, prompt: string, options: ProviderOptions): Promise<FixPlanOutput>;
  revalidate(root: string, prompt: string, options: ProviderOptions): Promise<RevalidateOutput>;
};
