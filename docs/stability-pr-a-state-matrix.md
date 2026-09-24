# STABILITY PR-A State Matrix

## Authoritative records

| Domain | Durable run | Job type | Generation fence |
| --- | --- | --- | --- |
| Book analysis | `BookAnalysisRun` | `book.analysis` | `dispatchGeneration` |
| Podcast generation | `PodcastGenerationRun` | `podcast.generation` | `dispatchGeneration` |
| Short video generation | `ShortVideoGenerationRun` | `short-video.generation` | `dispatchGeneration` |
| Podcast audio generation | `AudioGenerationRun` | `podcast.audio-generation` | `dispatchGeneration` |

Each run points to one `Job` through `jobId`. The run status is business truth. `Job.status` (`QUEUED` or `RUNNING`) is what consumes workspace capacity. The configured capacity remains 2 and admission serializes on the workspace-scoped `phase18-expensive-operation:<workspaceId>` advisory transaction lock.

Outbox events are not relationally attached to runs; `aggregateId` and the run ID plus `dispatchGeneration` in the payload identify the target. `DISPATCHED` records only that the dispatcher called BullMQ and finalized its database claim. It does not prove the BullMQ job still exists. Queue job IDs are generation-scoped by the domain dispatchers, and `Job.queueJobId` is written during outbox finalization. Run claim tokens and lease expiry are the execution-ownership authority.

## Decision matrix

| Fresh durable run | Job | Lease / generation | Outbox and BullMQ evidence | Decision |
| --- | --- | --- | --- | --- |
| `SUCCEEDED` | `QUEUED` or `RUNNING` | Any stale claim or generation | Any | **Terminal convergence.** Mark the active Job `SUCCEEDED`, clear stale run ownership metadata, release capacity. Never call a provider or rearm. |
| `FAILED` | `QUEUED` or `RUNNING` | Any stale claim or generation | Any | **Terminal convergence.** Mark the active Job `FAILED`, clear stale run ownership metadata, release capacity. Never retry because the run is `FAILED`. |
| `SUCCEEDED` or `FAILED` | Already terminal | Any | Any | No capacity is reserved; leave terminal Job history unchanged. |
| `QUEUED` + `QUEUED`, or `RUNNING` + `RUNNING` | Active | Current generation with a non-null owner token and unexpired lease | Any queue state | **`NOOP_ACTIVE_OWNER`.** A valid durable owner wins even if Redis inspection looks stale. |
| `QUEUED` + `QUEUED`, or `RUNNING` + `RUNNING` | Active | Current generation, no valid owner | Exact current-generation outbox is `PENDING` or `PROCESSING` | No recovery; the normal outbox dispatcher owns this transport work. |
| `QUEUED` + `QUEUED`, or `RUNNING` + `RUNNING` | Active | Current generation, no valid owner | Matching BullMQ job exists in a live queue state | **`NOOP_QUEUE_PRESENT`.** Queue presence is transport evidence only; it does not claim the run or change durable business status. |
| `QUEUED` + `QUEUED`, or `RUNNING` + `RUNNING` | Active | Current generation, no valid owner | Exact current-generation outbox is `DISPATCHED` or retry-exhausted `FAILED`; matching BullMQ job is absent or terminal | **Exact-target transport recovery** through that domain's existing rearm primitive, with commit-time identity, status, generation, and lease revalidation. |
| Any active run | Active | Candidate generation differs from the fresh run generation | Stale outbox/queue delivery | **`STALE_GENERATION_IGNORED`.** It cannot rearm, enqueue, claim, or consume capacity for the current run. |
| Any | Any | Missing/mismatched workspace, job type, run/job relation; missing or malformed current outbox identity; contradictory active statuses; database/Redis inspection failure | Inconsistent or unavailable evidence | **Fail closed.** Leave business and Job state untouched; record `AMBIGUOUS_SKIPPED` or `INFRA_FAILURE`. |
| Active run | `CANCELLED` or another terminal Job state | No corresponding run cancellation exists in the domain model | Any | Ambiguous mismatch; do not infer cancellation or resurrect the Job. |

All four run enums have `QUEUED`, `RUNNING`, `SUCCEEDED`, and `FAILED`; none has a business `CANCELLED` state. The existing exact rearm APIs also accept `FAILED` for explicit domain-owned recovery flows. PR-A must classify a fresh `FAILED` run as terminal first and must not call those helpers for it.

## Mutation and race rules

Discovery is advisory. For each exact candidate, re-read the Job and run in a transaction, lock the run row, and validate workspace, job type, run ID, job ID, run status, generation, owner token, and lease against current state. Terminal convergence may mutate an active Job only while holding the same workspace advisory lock used by capacity admission. Domain transport recovery remains inside each domain's exact rearm authority; audio also retains its semantic-identity lock, quarantine gate, lineage/currentness checks, and A1 dispatch rules.

Two reconcilers may inspect the same candidate. A terminal mutation is conditional and idempotent. Transport recovery uses a generation compare-and-set and creates its outbox event in the same transaction, so only one reconciler can advance the target generation. A fresh worker owner or successful terminal commit observed under the run-row lock defeats a stale scan.

## Lifecycle wiring

The worker retains bounded periodic scheduling for outbox dispatch and a 60-second Book-bootstrap sweep, and PR-A adds a cross-domain Job/run convergence sweep. Startup launches one bounded page without delaying readiness; the existing runtime scheduler calls another bounded page every 60 seconds. Each pass uses a stable keyset cursor and later sweeps continue the scan. No recovery path calls a provider.
