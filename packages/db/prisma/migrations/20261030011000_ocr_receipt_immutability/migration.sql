-- Receipts are append-only. Cascade deletion remains available for the existing
-- tenant lifecycle, but no caller can rewrite an execution's historical facts.
CREATE FUNCTION reject_ocr_receipt_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'OCR_EXECUTION_RECEIPT_IMMUTABLE' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER "OcrPageExecution_immutable" BEFORE UPDATE ON "OcrPageExecution"
FOR EACH ROW EXECUTE FUNCTION reject_ocr_receipt_update();
