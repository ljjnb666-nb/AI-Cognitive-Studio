-- A chunk identity is immutable within an audio-generation run, not globally across regenerations.
DROP INDEX "UtteranceSpeechChunk_synthesisIdentityHash_key";
CREATE UNIQUE INDEX "UtteranceSpeechChunk_audioGenerationRunId_synthesisIdentityHash_key"
  ON "UtteranceSpeechChunk"("audioGenerationRunId", "synthesisIdentityHash");
