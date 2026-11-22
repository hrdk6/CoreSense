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
    backgroundColor: '#000000',
  },
  plugins: {
    SplashScreen: {
      launchAutoHide: true,
      backgroundColor: '#000000',
    },
  },
};

export default config;
