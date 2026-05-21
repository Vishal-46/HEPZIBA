// Hepziba Minimal Theme: One palette, one font, unified tokens

export const COLOR = {
  background: '#F7F5F2', // App background
  surface: '#FFFFFF',    // Cards, modals, nav, input
  primary: '#5E6C84',    // Main actions
  accent: '#8EA7C5',     // Secondary/links
  text: '#2F3441',       // Main text
  success: '#4F766A',    // Success only
};

export const SPACING = {
  xs: 4,
  s: 8,
  m: 16,
  l: 24,
  xl: 32,
};

export const RADIUS = {
  sm: 8,
  md: 12,
  lg: 16,
};

export const SHADOW = {
  card: {
    shadowColor: COLOR.primary,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.04,
    shadowRadius: 12,
    elevation: 2,
  },
  button: {
    shadowColor: COLOR.primary,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 1,
  }
};

export const FONT = {
  regular: 'Manrope_400Regular',
  medium: 'Manrope_500Medium',
  bold: 'Manrope_700Bold',
};
