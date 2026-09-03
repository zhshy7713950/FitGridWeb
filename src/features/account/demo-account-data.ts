export const DEMO_ACCOUNT_MARKER = "fitgrid-demo-account-password-success";

export function changeDemoPassword(
  _currentPassword: string,
  _newPassword: string,
  signal?: AbortSignal,
): void {
  void _currentPassword;
  void _newPassword;
  void DEMO_ACCOUNT_MARKER;
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}
