export const VIDEO_RENDER_FFMPEG_FAILED = "VIDEO_RENDER_FFMPEG_FAILED";
export const VIDEO_RENDERING_STAGE = "VIDEO_RENDERING";
const STDERR_EXCERPT_MAX_LENGTH = 6_144;
const STDERR_TRUNCATION_MARKER = "\n[...truncated...]\n";

export type ExternalProcessDiagnostic = {
  adapter: "ffmpeg";
  exitCode: number | null;
  processCode: string | null;
  signal: string | null;
  killed: boolean;
  stderrExcerpt: string;
};

export type VideoRenderFailureDetails = ExternalProcessDiagnostic & {
  code: typeof VIDEO_RENDER_FFMPEG_FAILED;
  stage: typeof VIDEO_RENDERING_STAGE;
};

type ChildProcessFailure = {
  code?: unknown;
  signal?: unknown;
  killed?: unknown;
  stderr?: unknown;
};

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export function sanitizeProcessStderr(stderr: string, temporaryDirectory: string) {
  const normalized = stderr
    .replace(/\r\n?/g, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "")
    .replace(new RegExp(escapeRegExp(temporaryDirectory.replace(/\\\\/g, "/")), "g"), "<tmp>")
    .replace(new RegExp(escapeRegExp(temporaryDirectory), "g"), "<tmp>")
    .replace(/(?:postgres(?:ql)?|redis|s3):\/\/[^\s'"]+/gi, "<redacted-url>")
    .replace(/https?:\/\/[^\s'"]+/gi, "<redacted-url>");
  if (normalized.length <= STDERR_EXCERPT_MAX_LENGTH) return normalized;
  const headLength = 2_048;
  const tailLength = STDERR_EXCERPT_MAX_LENGTH - headLength - STDERR_TRUNCATION_MARKER.length;
  return `${normalized.slice(0, headLength)}${STDERR_TRUNCATION_MARKER}${normalized.slice(-tailLength)}`;
}

function processFailure(error: unknown): ChildProcessFailure {
  return isRecord(error) ? error : {};
}

export class VideoRenderProcessError extends Error {
  readonly code = VIDEO_RENDER_FFMPEG_FAILED;
  readonly stage = VIDEO_RENDERING_STAGE;
  readonly diagnostic: ExternalProcessDiagnostic;

  constructor(error: unknown, temporaryDirectory: string) {
    super(VIDEO_RENDER_FFMPEG_FAILED);
    this.name = "VideoRenderProcessError";
    const failure = processFailure(error);
    this.diagnostic = {
      adapter: "ffmpeg",
      exitCode: typeof failure.code === "number" && Number.isInteger(failure.code) ? failure.code : null,
      processCode: typeof failure.code === "string" ? failure.code : null,
      signal: typeof failure.signal === "string" ? failure.signal : null,
      killed: failure.killed === true,
      stderrExcerpt: sanitizeProcessStderr(
        typeof failure.stderr === "string" ? failure.stderr : "",
        temporaryDirectory,
      ),
    };
  }
}

export function videoRenderFailureDetails(error: unknown): VideoRenderFailureDetails | undefined {
  if (!(error instanceof VideoRenderProcessError)) return undefined;
  return { code: error.code, stage: error.stage, ...error.diagnostic };
}

export const PROCESS_STDERR_EXCERPT_MAX_LENGTH = STDERR_EXCERPT_MAX_LENGTH;
