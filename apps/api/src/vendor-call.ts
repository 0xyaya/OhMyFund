const failures = new Map<string, { count: number; openUntil: number }>();

export async function vendorCall<T>(name: string, run: (signal: AbortSignal) => Promise<T>, options: { timeoutMs: number; retries: number }) {
  const state = failures.get(name);
  if (state && state.openUntil > Date.now()) throw new Error(`${name} circuit breaker is open.`);
  let lastError: unknown;
  for (let attempt = 0; attempt <= options.retries; attempt++) {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout>;
    try {
      const result = await Promise.race([
        run(controller.signal),
        new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => { controller.abort(); reject(new Error(`${name} timed out.`)); }, options.timeoutMs); })
      ]);
      failures.delete(name);
      return result;
    } catch (error) {
      lastError = error;
      if (attempt < options.retries) await new Promise(resolve => setTimeout(resolve, 200 * 2 ** attempt));
    } finally { clearTimeout(timeout!); }
  }
  const count = (state?.count ?? 0) + 1;
  failures.set(name, { count, openUntil: count >= 5 ? Date.now() + 30_000 : 0 });
  throw lastError;
}
