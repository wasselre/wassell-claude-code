import type { ConsoleMessage, Page } from 'playwright-core';

export interface WaitCaptchaStep {
  do: 'wait_captcha';
  timeout_s?: number;
  token_selector?: string;
  /** Positive evidence that sign-in advanced, never the absence of a widget. */
  success_selector?: string;
  /** Exact URL, or re:<regular expression>. */
  success_url?: string;
}

export const READ_CAPTCHA_TOKEN = new Function('selector', `
  return Array.prototype.some.call(document.querySelectorAll(selector), function (el) {
    return typeof el.value === 'string' && el.value.trim().length > 0;
  });
`) as (selector: string) => boolean;

/** Browserbase owns solving. Its finished event is observability only.
 * Configured page advancement must succeed; standalone checks require a token. */
export async function waitForAutomaticCaptcha(
  page: Page,
  step: WaitCaptchaStep,
  hooks: {
    checkCancelled: () => Promise<void>;
    heartbeat?: () => Promise<void>;
    log: (msg: string) => void;
    screenshot: (label: string) => Promise<void>;
  },
): Promise<void> {
  const timeout = step.timeout_s ?? 180;
  if (!Number.isFinite(timeout) || timeout < 1 || timeout > 300) throw new Error('wait_captcha timeout_s must be 1..300');
  const deadline = Date.now() + timeout * 1000;
  let heartbeatAt = -Infinity;
  const requiresPageAdvancement = Boolean(step.success_selector || step.success_url);
  const urlMatches = step.success_url?.startsWith('re:') ? new RegExp(step.success_url.slice(3)) : null;
  const consoleListener = (message: ConsoleMessage) => {
    const text = message.text();
    if (text === 'browserbase-solving-started' || text === 'browserbase-solving-finished') hooks.log(text);
  };
  page.on('console', consoleListener);
  hooks.log('waiting for Browserbase automatic CAPTCHA solving');
  try {
    while (Date.now() < deadline) {
      await hooks.checkCancelled();
      if (Date.now() - heartbeatAt >= 6000) {
        await hooks.heartbeat?.();
        heartbeatAt = Date.now();
      }
      const advanced = step.success_url && (urlMatches ? urlMatches.test(page.url()) : page.url() === step.success_url);
      if (advanced || (step.success_selector && await page.locator(step.success_selector).first().isVisible())) {
        hooks.log('CAPTCHA verified: page advanced');
        return;
      }
      let token: boolean;
      try {
        token = await page.evaluate(READ_CAPTCHA_TOKEN, step.token_selector ?? '[name="g-recaptcha-response"], [name="h-captcha-response"], [name="cf-turnstile-response"]');
      } catch (error) {
        // A CAPTCHA callback may navigate between the URL check and evaluate.
        // Only that execution-context race is retried; all other failures stop.
        if (!(error instanceof Error) || !/Execution context was destroyed|Cannot find context with specified id/.test(error.message)) throw error;
        hooks.log('CAPTCHA callback navigated; checking the new page');
        await page.waitForTimeout(250);
        continue;
      }
      if (token && !requiresPageAdvancement) {
        hooks.log('CAPTCHA verified: response token present');
        return;
      }
      await page.waitForTimeout(Math.min(1000, Math.max(1, deadline - Date.now())));
    }
    await hooks.screenshot('captcha-timeout');
    throw new Error(requiresPageAdvancement
      ? 'Browserbase CAPTCHA solving timed out without the configured page advancement'
      : 'Browserbase CAPTCHA solving timed out without a response token');
  } finally {
    page.off('console', consoleListener);
  }
}
