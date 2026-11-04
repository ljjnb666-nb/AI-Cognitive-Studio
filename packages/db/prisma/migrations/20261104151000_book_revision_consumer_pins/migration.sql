CREATE UNIQUE INDEX "BookRevisionPublication_id_analysisRunId_key"
ON "BookRevisionPublication" ("id", "analysisRunId");

ALTER TABLE "PodcastGenerationSource" ADD COLUMN "bookPublicationId" TEXT,
  ADD CONSTRAINT "PodcastGenerationSource_book_publication_fkey"
  FOREIGN KEY ("bookPublicationId", "analysisRunId")
  REFERENCES "BookRevisionPublication" ("id", "analysisRunId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ShortVideoGenerationSource" ADD COLUMN "bookPublicationId" TEXT,
  ADD CONSTRAINT "ShortVideoGenerationSource_book_publication_fkey"
  FOREIGN KEY ("bookPublicationId", "analysisRunId")
  REFERENCES "BookRevisionPublication" ("id", "analysisRunId") ON DELETE RESTRICT ON UPDATE CASCADE;
