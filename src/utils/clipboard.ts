/**
 * Utilitas penyalinan clipboard yang andal untuk semua browser, webview, dan iframe.
 * Mendukung Async Clipboard API dengan fallback otomatis document.execCommand('copy').
 */
export async function copyToClipboard(text: string | number | undefined | null): Promise<boolean> {
  if (text === undefined || text === null) return false;
  const str = String(text).trim();
  if (!str) return false;

  // 1. Coba modern Async Clipboard API terlebih dahulu
  if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(str);
      return true;
    } catch {
      // Abaikan error (mis. NotAllowedError / permissions policy di dalam iframe)
      // dan lanjutkan ke fallback textarea di bawah
    }
  }

  // 2. Fallback tangguh: textarea sementara + document.execCommand('copy')
  try {
    if (typeof document === 'undefined') return false;

    const textArea = document.createElement('textarea');
    textArea.value = str;

    // Pastikan elemen tidak terlihat dan tidak menggeser halaman
    textArea.style.position = 'fixed';
    textArea.style.top = '0';
    textArea.style.left = '0';
    textArea.style.width = '2em';
    textArea.style.height = '2em';
    textArea.style.padding = '0';
    textArea.style.border = 'none';
    textArea.style.outline = 'none';
    textArea.style.boxShadow = 'none';
    textArea.style.background = 'transparent';
    textArea.style.opacity = '0.01';
    textArea.style.pointerEvents = 'none';
    textArea.setAttribute('readonly', '');

    document.body.appendChild(textArea);

    // Seleksi teks
    textArea.focus({ preventScroll: true });
    textArea.select();
    textArea.setSelectionRange(0, str.length);

    const successful = document.execCommand('copy');
    document.body.removeChild(textArea);

    return successful;
  } catch (err) {
    console.error('Penyalinan clipboard gagal pada semua metode:', err);
    return false;
  }
}
