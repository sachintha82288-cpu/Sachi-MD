function isYoutubeAuthError(value) {
  const text = String(value || '').toLowerCase();
  return (
    text.includes('sign in to confirm') ||
    text.includes('login_required') ||
    text.includes('use --cookies-from-browser') ||
    text.includes('authentication required')
  );
}

module.exports = { isYoutubeAuthError };
