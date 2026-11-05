-- Exact ranking in PostgreSQL bounds application memory and filters before LIMIT.
-- JSON storage stays authoritative; no second vector store is introduced.
CREATE FUNCTION acs_cosine(a jsonb, b jsonb) RETURNS double precision
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
DECLARE result double precision;
BEGIN
  IF jsonb_typeof(a) <> 'array' OR jsonb_typeof(b) <> 'array' THEN RETURN NULL; END IF;
  IF jsonb_array_length(a) = 0 OR jsonb_array_length(a) <> jsonb_array_length(b) THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(a) x WHERE jsonb_typeof(x) <> 'number')
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(b) x WHERE jsonb_typeof(x) <> 'number') THEN RETURN NULL; END IF;
  SELECT sum(x.value::double precision * y.value::double precision) /
    NULLIF(sqrt(sum(power(x.value::double precision,2))) * sqrt(sum(power(y.value::double precision,2))),0)
  INTO result FROM jsonb_array_elements_text(a) WITH ORDINALITY x(value,n)
  JOIN jsonb_array_elements_text(b) WITH ORDINALITY y(value,n) USING (n);
  RETURN result;
EXCEPTION WHEN numeric_value_out_of_range OR invalid_text_representation THEN RETURN NULL;
END;
$$;
CREATE INDEX "BookMemoryEmbedding_search_idx" ON "BookMemoryEmbedding" ("workspaceId", "analysisRunId", "embeddingIdentityHash");
