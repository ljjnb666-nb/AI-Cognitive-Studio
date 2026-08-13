export function developmentBootstrapAllowed(environment: NodeJS.ProcessEnv = process.env): boolean {
  if (environment.NODE_ENV === "production") {
    return environment.PHASE6_BROWSER_ACCEPTANCE === "true"
      && environment.WEB_DEV_BOOTSTRAP_IDENTITY === "true"
      && environment.DATABASE_URL?.includes("ai_cognitive_studio_phase6_test") === true;
  }

  return environment.WEB_DEV_BOOTSTRAP_IDENTITY === "true";
}
