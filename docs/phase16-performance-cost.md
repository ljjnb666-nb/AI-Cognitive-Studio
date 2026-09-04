# Phase 16 performance, cost, and generation efficiency

Phase 16 cost estimates are not billing records. They are deterministic engineering estimates over normalized Provider usage, using a versioned local pricing catalog. Unknown price is `UNPRICED`, missing meter data is `MISSING_USAGE`, and locally counted speech Unicode code points are `LOCAL_DETERMINISTIC_ESTIMATE`; neither is represented as zero cost.

Text cost independently prices uncached input (`inputTokens - cachedInputTokens`), cached input, and output in integer micro-USD. Embedding and speech each use their declared catalog unit. Invalid cached input greater than total input is reported as invalid metering. No live price scraping, automatic model switching, generic cross-workspace caching, or customer billing UI is included.

Provider reports are scoped to one workspace and a bounded time window (or correlation id), and expose attempts, retry usage/cost, P50/P95 nearest-rank latency, coverage, and durable receipt reuse separately from native cached input. Raw prompts, source text, credentials, Authorization headers, and full Provider response bodies are excluded from usage metadata.

All five BullMQ workers and the optional outbox dispatcher have explicit configuration with a default of `1` and hard startup validation of `1..32`. Outbox concurrency keeps each event's claim, queue add, and claim-token guarded finalization independent. This phase measures throughput; it does not add distributed fairness scheduling or blind parallel TTS.

The deterministic benchmark emits synthetic book and 15/30/60 minute podcast profiles, query-plan metadata, queue bounds, and Provider usage reports. These fixtures are for relative regression detection only, never real-world cost claims.
