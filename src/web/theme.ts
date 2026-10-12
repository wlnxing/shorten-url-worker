// Shared semantic tokens for Ant Design components and the workspace layout.
// Keep changes here so controls, charts, and custom surfaces use the same palette.
export const tokens = {
  colorPrimary: '#4f46e5',
  colorSuccess: '#147a53',
  colorWarning: '#946200',
  colorError: '#c32f3b',
  colorText: '#202636',
  colorTextSecondary: '#606b80',
  colorBorder: '#dce1ea',
  colorBgLayout: '#f6f8fb',
  colorBgContainer: '#ffffff',
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
  fontSize: 14,
  borderRadius: 8,
  controlHeight: 40,
};

export const uiTheme = {
  token: {
    ...tokens,
    colorInfo: tokens.colorPrimary,
    colorPrimaryBg: '#eef0ff',
    colorInfoBg: '#eef0ff',
    colorInfoText: '#4338ca',
    colorSuccessBg: '#edf7f1',
    colorSuccessText: '#146c4a',
    colorWarningBg: '#fff7e8',
    colorWarningText: '#8b5c00',
    colorErrorBg: '#fff1f0',
    colorErrorText: '#b42332',
  },
  components: {
    Button: { primaryShadow: '0 2px 3px rgba(79, 70, 229, 0.12)' },
    Modal: { borderRadiusLG: 16 },
    Tooltip: { borderRadius: 6 },
  },
};

export const themeVariables = {
  '--color-primary': tokens.colorPrimary,
  '--color-success': tokens.colorSuccess,
  '--color-warning': tokens.colorWarning,
  '--color-error': tokens.colorError,
  '--color-text': tokens.colorText,
  '--color-muted': tokens.colorTextSecondary,
  '--color-border': tokens.colorBorder,
  '--color-canvas': tokens.colorBgLayout,
  '--color-surface': tokens.colorBgContainer,
  '--font-sans': tokens.fontFamily,
};
