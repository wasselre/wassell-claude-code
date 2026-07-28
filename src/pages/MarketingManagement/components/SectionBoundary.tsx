/**
 * One failing section must not take the page down.
 *
 * This page has no error boundary today, so a single unexpected API shape
 * unmounts the whole tree and leaves a blank screen with nothing to act on. That
 * is not theoretical: while testing, three different malformed responses each
 * white-screened the entire Marketing Management page — one of them
 * `PublishingTab` calling .filter on an undefined `publications`. A real 500, a
 * partial deploy, or a schema drift would do the same to a user, and the only
 * signal would be "the page is broken".
 *
 * Scope is deliberately per-section rather than per-page: if Publishing throws,
 * the nav, the other eleven sections and the user's place in the app all
 * survive. The error text is shown rather than hidden, because a person who can
 * read "cannot read properties of undefined" can report something useful.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';

interface Props {
  children: ReactNode;
  /** Section name, already localised by the caller. */
  label: string;
  isAr: boolean;
  /** Changes when the user switches section, so a fixed section recovers
   *  without a page reload. */
  resetKey?: string;
}
interface State { error: Error | null }

export class SectionBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidUpdate(prev: Props) {
    // Leaving a broken section clears the error, so returning to it retries
    // instead of showing a stale failure forever.
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Loud, per the codebase rule: a swallowed render failure is exactly the
    // kind of silent breakage this project has been bitten by.
    console.error(`[marketing-mgmt] section "${this.props.label}" failed to render`,
      error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    const { isAr, label, children } = this.props;
    if (!error) return children;

    return (
      <div className="rounded-2xl border border-red-200 bg-red-50 p-4">
        <div className="flex items-center gap-2 text-[14px] font-semibold text-red-900">
          <AlertTriangle className="h-4.5 w-4.5" />
          {isAr ? `تعذّر عرض قسم «${label}»` : `The “${label}” section failed to render`}
        </div>
        <p className="mt-1 text-[12.5px] text-red-800">
          {isAr
            ? 'بقية الصفحة تعمل. هذا خطأ في العرض، وليس فقدان بيانات — لم يُحفظ أو يُحذف شيء.'
            : 'The rest of the page still works. This is a rendering failure, not data loss — nothing was saved or deleted.'}
        </p>
        <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-lg
                        border border-red-200 bg-white p-2 font-mono text-[11px] text-red-900">
          {error.message || String(error)}
        </pre>
        <button type="button" onClick={() => this.setState({ error: null })}
          className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-red-300 bg-white
                     px-2.5 py-1 text-[12px] font-medium text-red-800 hover:bg-red-100">
          <RotateCcw className="h-3.5 w-3.5" />{isAr ? 'إعادة المحاولة' : 'Try again'}
        </button>
      </div>
    );
  }
}
