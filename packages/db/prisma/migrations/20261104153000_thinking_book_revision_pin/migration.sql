ALTER TABLE "ThinkingSession" ADD COLUMN "bookPublicationId" TEXT,
  ADD CONSTRAINT "ThinkingSession_book_publication_fkey"
  FOREIGN KEY ("bookPublicationId") REFERENCES "BookRevisionPublication" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
