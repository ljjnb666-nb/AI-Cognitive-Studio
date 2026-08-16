import { randomUUID } from "node:crypto";

export type E2EWorkerTopics = {
  sourceIngestion: string;
  bookAnalysis: string;
  podcastGeneration: string;
  podcastAudio: string;
  shortVideo: string;
};

export type E2EWorkerIsolation = {
  id: string;
  bullmqPrefix: string;
  topics: E2EWorkerTopics;
};

export function createE2EWorkerIsolation(phase: string): E2EWorkerIsolation {
  const id = randomUUID().replaceAll("-", "");
  const prefix = `${phase}-e2e-${id}`;
  return {
    id,
    bullmqPrefix: prefix,
    topics: {
      sourceIngestion: `source.ingestion.requested.${prefix}`,
      bookAnalysis: `book.analysis.requested.${prefix}`,
      podcastGeneration: `podcast.generation.requested.${prefix}`,
      podcastAudio: `podcast.audio-generation.requested.${prefix}`,
      shortVideo: `short-video.generation.requested.${prefix}`,
    },
  };
}
