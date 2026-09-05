/**
 * Browser client for the public job-application endpoints. Uploads go DIRECTLY
 * to Supabase Storage via a one-shot signed url (so Vercel's ~4.5 MB body cap is
 * never in the byte path), with real upload-progress via XHR.
 */

export interface UploadResult {
  path: string;
  size: number;
  mime: string;
  name: string;
}

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;

/** Ask the API for a one-shot signed upload url for this submission's CV/audio. */
async function requestUploadUrl(
  submissionId: string, kind: 'cv' | 'audio', file: Blob & { name?: string },
): Promise<{ path: string; token: string }> {
  const resp = await fetch('/api/careers/upload-url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      submissionId,
      kind,
      filename: file.name ?? '',
      mime: file.type ?? '',
      size: file.size,
    }),
  });
  if (!resp.ok) {
    const msg = await resp.json().catch(() => ({}));
    throw new Error((msg as { error?: string }).error || `upload-url failed (${resp.status})`);
  }
  return (await resp.json()) as { path: string; token: string };
}

/** PUT the bytes to a Supabase signed upload url with progress callbacks. */
function putToSignedUrl(
  bucket: string, path: string, token: string, file: Blob,
  onProgress?: (fraction: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!SUPABASE_URL) {
      reject(new Error('Supabase URL not configured'));
      return;
    }
    const url = `${SUPABASE_URL}/storage/v1/object/upload/sign/${bucket}/${path}?token=${encodeURIComponent(token)}`;
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('x-upsert', 'true');
    if (file.type) xhr.setRequestHeader('Content-Type', file.type);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('network error during upload'));
    xhr.onabort = () => reject(new Error('upload cancelled'));
    xhr.send(file);
  });
}

const JOB_APP_BUCKET = 'job-applications';

/** Upload a CV or audio file, returning its storage path + verified size/mime. */
export async function uploadCareerFile(
  submissionId: string,
  kind: 'cv' | 'audio',
  file: File | Blob,
  filename: string,
  onProgress?: (fraction: number) => void,
): Promise<UploadResult> {
  const named = file instanceof File ? file : Object.assign(file, { name: filename });
  const { path, token } = await requestUploadUrl(submissionId, kind, named as Blob & { name?: string });
  await putToSignedUrl(JOB_APP_BUCKET, path, token, file, onProgress);
  return { path, size: file.size, mime: file.type || '', name: filename };
}

export interface SubmitPayload {
  submissionId: string;
  fullName: string;
  phone: string;
  currentSituation: string;
  experienceLevel: string;
  experienceResults: string;
  canCommit: string;
  expectedSalary: string;
  expectedCommission: string;
  additionalNotes: string;
  cvPath: string;
  cvName: string;
  audioPath: string;
  audioDurationSec: number;
  sourceUrl: string;
  utm: Record<string, string>;
  clickIds: Record<string, string>;
}

/** Submit the completed application. Idempotent server-side on submissionId. */
export async function submitApplication(payload: SubmitPayload): Promise<{ ok: true; id: string }> {
  const resp = await fetch('/api/careers/submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const json = (await resp.json().catch(() => ({}))) as { ok?: boolean; id?: string; error?: string };
  if (!resp.ok || !json.ok || !json.id) {
    throw new Error(json.error || `submission failed (${resp.status})`);
  }
  return { ok: true, id: json.id };
}
