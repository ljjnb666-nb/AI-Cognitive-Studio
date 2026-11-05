ALTER TABLE "TeachBackAttempt" ADD COLUMN "bookPublicationId" TEXT,
  ADD CONSTRAINT "TeachBackAttempt_book_publication_fkey"
  FOREIGN KEY ("bookPublicationId") REFERENCES "BookRevisionPublication" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
