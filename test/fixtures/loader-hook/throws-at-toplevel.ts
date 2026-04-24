const code = "ERR_FIXTURE_TOP_LEVEL";
const err = new Error("fixture error") as Error & { code: string };
err.code = code;
throw err;
