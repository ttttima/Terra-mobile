import { defineConfig } from 'vite';

// Builds phone.html (the UI) into the Android app's assets. `npm run apk`
// runs this, then Gradle (scripts/build-apk.mjs); `npm run dev` serves it in
// a normal browser with a stand-in for the native app (src/phone/host.ts).
export default defineConfig({
  base: './',
  build: {
    outDir: 'android/app/src/main/assets/ui',
    emptyOutDir: true,
    rollupOptions: {
      input: 'phone.html',
    },
  },
});
