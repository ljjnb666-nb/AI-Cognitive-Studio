# Phase 3 podcast script quality contract

Phase 3 turns bounded Book Intelligence into a grounded, multi-host podcast script. Naturalness is a product invariant, not a prompt adjective. The output must read as an intelligent spoken exchange rather than alternating summaries, a converted outline, or equal-length assistant responses.

## Naturalness and host differentiation

- Hosts have versioned, structured personas. Their role, skepticism, verbosity, question style, disagreement style, sentence-length preference, and filler preference influence generation.
- Controlled asymmetry is expected: uneven turn length, short reactions, occasional consecutive turns, callbacks, partial disagreement, and different utterance-type distributions.
- Filler, interruption, and unfinished transitions are used sparingly. Random noise, pervasive stuttering, grammatical corruption, and chaotic topic movement are not naturalness.
- Deterministic regression metrics cover turn share, average length and variance, question/reaction/challenge rates, lexical similarity, agreement and transition density, summary density, and repeated n-grams. These metrics are warning signals, not proof of humanity.

## Fabrication boundary

Hosts may express rhetorical perspective, intuition, or a hypothetical scene. They may not invent biographies, employment, friendships, or lived experiences as factual evidence. A detected unsupported biography is a hard failure. Humanization cannot add claims or evidence.

## Grounding and provenance

- Every substantive source-derived utterance has evidence rooted in the generation run's immutable Phase 2 lineage.
- Evidence leads through `BookMemoryItem` to `SourceBlock` and JavaScript UTF-16 half-open offsets `[startOffset,endOffset)`.
- Grounding validation runs after humanization and rejects cross-source lineage, invalid offsets, inexact quote evidence, detached direct quotes, and unsupported substantive claims.
- Reactions and conversational glue do not require citations. Unsupported claims are removed, reframed as interpretation, or regenerated at the bounded segment level; evidence is never invented.

## Anti-template and source-copy rules

Repeated generic agreement, formal essay transitions, mechanical `first/second/finally` sequences, repeated summaries, identical host vocabulary, and symmetric turn lengths produce warnings and lower deterministic scores. One natural occurrence is not banned; density is measured.

The script is transformative discussion, not audiobook reproduction. Direct quotes must be short, purposeful, exact, and evidenced. Long sequential overlap with source text is a source-copy risk and can become a hard policy failure at stricter deployment thresholds.

## Hard failures and warnings

Hard failures include malformed provider output, invalid or cross-workspace provenance, unsupported substantive claims, unsupported quote evidence, fabricated factual biography, full-book prompts, and token-budget violations. Warnings include host similarity, low turn-length variance, low disagreement, elevated generic agreement, formal transitions, repetition, and summary density.

No TTS, audio, voice cloning, mixing, music, waveform, video, or short-video behavior belongs to this contract.
