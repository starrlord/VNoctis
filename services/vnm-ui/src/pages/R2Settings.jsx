import { useState, useEffect, useRef } from 'react';
import useSettings from '../hooks/useSettings';
import useSetup from '../hooks/useSetup';

/**
 * R2 Settings modal — admin-only modal for configuring Cloudflare R2 credentials.
 *
 * @param {{
 *   open: boolean,
 *   onClose: () => void,
 * }} props
 */
export default function R2Settings({ open, onClose }) {
  const { config, loading, error, saving, saveError, testing, testResult, saveConfig, testConnection } = useSettings();
  const { runSetup, running: setupRunning, result: setupResult } = useSetup();
  const modalRef = useRef(null);
  const previousFocusRef = useRef(null);

  const [form, setForm] = useState({
    accountId: '',
    accessKeyId: '',
    secretAccessKey: '',
    bucketName: '',
    publicUrl: '',
    apiToken: '',
  });
  const [showSecret, setShowSecret] = useState(false);
  const [showApiToken, setShowApiToken] = useState(false);

  // Populate form once config loads
  useEffect(() => {
    if (config) {
      setForm({
        accountId: config.accountId || '',
        accessKeyId: config.accessKeyId || '',
        secretAccessKey: config.secretAccessKey || '',
        bucketName: config.bucketName || '',
        publicUrl: config.publicUrl || '',
        apiToken: config.apiToken || '',
      });
    }
  }, [config]);

  // Prevent body scroll while modal is open
  useEffect(() => {
    if (!open) return;
    const scrollY = window.scrollY;
    document.body.style.position = 'fixed';
    document.body.style.top = `-${scrollY}px`;
    document.body.style.left = '0';
    document.body.style.right = '0';
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.position = '';
      document.body.style.top = '';
      document.body.style.left = '';
      document.body.style.right = '';
      document.body.style.overflow = '';
      window.scrollTo(0, scrollY);
    };
  }, [open]);

  // Focus trap & Escape key
  useEffect(() => {
    if (!open) return;
    previousFocusRef.current = document.activeElement;
    modalRef.current?.focus();

    const handleKey = (e) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key === 'Tab' && modalRef.current) {
        const focusable = modalRef.current.querySelectorAll(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    window.addEventListener('keydown', handleKey);
    return () => {
      window.removeEventListener('keydown', handleKey);
      previousFocusRef.current?.focus();
    };
  }, [open, onClose]);

  const handleChange = (e) => {
    setForm((prev) => ({ ...prev, [e.target.name]: e.target.value }));
  };

  const handleSave = async (e) => {
    e.preventDefault();
    const ok = await saveConfig(form);
    if (ok) onClose();
  };

  const handleTest = () => testConnection(form);

  let setupDisabled = setupRunning || saving;
  try {
    if (form.publicUrl) new URL(form.publicUrl).hostname;
    else setupDisabled = true;
  } catch {
    setupDisabled = true;
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={modalRef}
        tabIndex={-1}
        className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-2xl w-full max-w-2xl max-h-[90dvh] overflow-y-auto outline-none"
      >
        {/* Header */}
        <div className="sticky top-0 z-10 bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 px-6 py-4 flex items-center justify-between rounded-t-xl">
          <div className="flex items-center gap-3">
            <svg className="w-6 h-6 text-blue-500" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 16.5V9.75m0 0 3 3m-3-3-3 3M6.75 19.5a4.5 4.5 0 0 1-1.41-8.775 5.25 5.25 0 0 1 10.233-2.33 3 3 0 0 1 3.758 3.848A3.752 3.752 0 0 1 18 19.5H6.75Z" />
            </svg>
            <div>
              <h2 className="text-lg font-bold text-gray-900 dark:text-white">Cloudflare R2 Publishing</h2>
              <p className="text-xs text-gray-500 dark:text-gray-400">Configure your R2 bucket to publish web builds as a public static gallery.</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
            aria-label="Close"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5">
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <svg className="animate-spin h-8 w-8 text-blue-500" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            </div>
          ) : error ? (
            <div className="text-center py-8">
              <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-6">
                <p className="text-red-600 dark:text-red-400 font-medium">Failed to load R2 settings</p>
                <p className="text-sm text-red-500 dark:text-red-500 mt-1">{error}</p>
                <p className="text-sm text-gray-500 dark:text-gray-400 mt-3">
                  Make sure <code className="bg-gray-100 dark:bg-gray-800 px-1 rounded">VNM_R2_MODE=true</code> is set in your <code className="bg-gray-100 dark:bg-gray-800 px-1 rounded">.env</code> file.
                </p>
              </div>
            </div>
          ) : (
            <form onSubmit={handleSave} className="space-y-5">
              <div className="space-y-5">
                <Field label="Cloudflare Account ID" htmlFor="accountId" hint="Found in your Cloudflare dashboard URL">
                  <Input
                    id="accountId"
                    name="accountId"
                    value={form.accountId}
                    onChange={handleChange}
                    placeholder="abc123def456"
                    required
                  />
                </Field>

                <Field label="Access Key ID" htmlFor="accessKeyId">
                  <Input
                    id="accessKeyId"
                    name="accessKeyId"
                    value={form.accessKeyId}
                    onChange={handleChange}
                    placeholder="R2 access key ID"
                    required
                  />
                </Field>

                <Field label="Secret Access Key" htmlFor="secretAccessKey">
                  <div className="relative">
                    <Input
                      id="secretAccessKey"
                      name="secretAccessKey"
                      type={showSecret ? 'text' : 'password'}
                      value={form.secretAccessKey}
                      onChange={handleChange}
                      placeholder="R2 secret access key"
                      className="pr-10"
                    />
                    <button
                      type="button"
                      onClick={() => setShowSecret((v) => !v)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                      tabIndex={-1}
                    >
                      {showSecret ? (
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M3.98 8.223A10.477 10.477 0 0 0 1.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.451 10.451 0 0 1 12 4.5c4.756 0 8.773 3.162 10.065 7.498a10.522 10.522 0 0 1-4.293 5.774M6.228 6.228 3 3m3.228 3.228 3.65 3.65m7.894 7.894L21 21m-3.228-3.228-3.65-3.65m0 0a3 3 0 1 0-4.243-4.243m4.242 4.242L9.88 9.88" />
                        </svg>
                      ) : (
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z" />
                          <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
                        </svg>
                      )}
                    </button>
                  </div>
                </Field>

                <Field label="Cloudflare API Token" htmlFor="apiToken" hint="Requires Zone Read, Transform Rules Edit, and R2 Edit permissions. Used to connect your domain and configure rewrite rules automatically.">
                  <div className="relative">
                    <Input
                      id="apiToken"
                      name="apiToken"
                      type={showApiToken ? 'text' : 'password'}
                      value={form.apiToken}
                      onChange={handleChange}
                      placeholder="Cloudflare API token"
                      className="pr-10"
                    />
                    <button
                      type="button"
                      onClick={() => setShowApiToken((v) => !v)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                      tabIndex={-1}
                    >
                      {showApiToken ? (
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M3.98 8.223A10.477 10.477 0 0 0 1.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.451 10.451 0 0 1 12 4.5c4.756 0 8.773 3.162 10.065 7.498a10.522 10.522 0 0 1-4.293 5.774M6.228 6.228 3 3m3.228 3.228 3.65 3.65m7.894 7.894L21 21m-3.228-3.228-3.65-3.65m0 0a3 3 0 1 0-4.243-4.243m4.242 4.242L9.88 9.88" />
                        </svg>
                      ) : (
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z" />
                          <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
                        </svg>
                      )}
                    </button>
                  </div>
                </Field>

                <Field label="Bucket Name" htmlFor="bucketName" hint="The bucket will be automatically created by Setup Domain if it doesn't exist yet">
                  <Input
                    id="bucketName"
                    name="bucketName"
                    value={form.bucketName}
                    onChange={handleChange}
                    placeholder="vnoctis-public"
                    required
                  />
                </Field>

                <Field label="Public URL" htmlFor="publicUrl" hint="The HTTPS URL where your bucket is publicly accessible">
                  <Input
                    id="publicUrl"
                    name="publicUrl"
                    type="url"
                    value={form.publicUrl}
                    onChange={handleChange}
                    placeholder="https://games.example.com"
                    required
                  />
                </Field>
              </div>

              {/* Feedback messages */}
              {saveError && (
                <p className="text-sm text-red-500 dark:text-red-400">{saveError}</p>
              )}
              {testResult && (
                <div className={`text-sm px-4 py-3 rounded-lg border ${
                  testResult.success
                    ? 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800 text-green-700 dark:text-green-400'
                    : 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800 text-red-700 dark:text-red-400'
                }`}>
                  {testResult.success ? '✓ ' : '✗ '}{testResult.message}
                </div>
              )}

              {setupResult && (
                <div className="text-sm px-4 py-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 space-y-1">
                  <SetupLine status={setupResult.bucketStatus} labels={{
                    already_exists: 'Bucket already exists',
                    created: 'Bucket created',
                    failed: 'Bucket creation failed',
                  }} />
                  <SetupLine status={setupResult.domainStatus} labels={{
                    already_connected: 'Custom domain already connected',
                    connected: 'Custom domain connected',
                    failed: 'Custom domain setup failed',
                  }} />
                  <SetupLine status={setupResult.ruleStatus} labels={{
                    already_exists: 'Rewrite rule already exists',
                    created: 'Rewrite rule created',
                    failed: 'Rewrite rule setup failed',
                  }} />
                  {setupResult.errors?.map((e, i) => (
                    <p key={i} className="text-red-500 dark:text-red-400 text-xs mt-1">{e}</p>
                  ))}
                </div>
              )}

              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={handleTest}
                  disabled={testing || saving}
                  className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {testing ? (
                    <>
                      <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                      </svg>
                      Testing…
                    </>
                  ) : 'Test Connection'}
                </button>

                <button
                  type="button"
                  onClick={runSetup}
                  disabled={setupDisabled}
                  className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {setupRunning ? (
                    <>
                      <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                      </svg>
                      Setting up…
                    </>
                  ) : 'Setup Domain'}
                </button>

                <button
                  type="submit"
                  disabled={saving || testing}
                  className="flex items-center gap-2 px-5 py-2 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-500 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {saving ? (
                    <>
                      <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                      </svg>
                      Saving…
                    </>
                  ) : 'Save Settings'}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

function SetupLine({ status, labels }) {
  const isOk = status !== 'failed';
  return (
    <p className={isOk ? 'text-green-600 dark:text-green-400' : 'text-red-500 dark:text-red-400'}>
      {isOk ? '✓' : '✗'} {labels[status] ?? status}
    </p>
  );
}

function Field({ label, htmlFor, hint, children }) {
  return (
    <div>
      <label htmlFor={htmlFor} className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
        {label}
      </label>
      {children}
      {hint && <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{hint}</p>}
    </div>
  );
}

function Input({ className = '', ...props }) {
  return (
    <input
      className={`w-full px-3 py-2 text-sm bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-lg text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-colors ${className}`}
      {...props}
    />
  );
}
