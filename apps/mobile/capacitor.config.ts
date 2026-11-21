import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.coresense.mobile',
  appName: 'CoreSense',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
    iosScheme: 'coresense',
  },
  ios: {
    contentInset: 'automatic',
  },
  android: {
    allowMixedContent: false,
    backgroundColor: '#0B0E14',
  },
  plugins: {
    SplashScreen: {
      launchAutoHide: true,
      backgroundColor: '#0B0E14',
    },
  },
};

export default config;
