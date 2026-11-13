// Builds Terra for Android: the phone UI (Vite) into the app's assets, then
// the APK (Gradle), copied to out/Terra-<version>.apk.
//
//   npm run apk           signed release APK
//   npm run apk -- debug  debug APK (web pages can be inspected from Chrome)
//
// Needs Android Studio (for its Java and the Android SDK). The first build
// makes a signing key in android/terra-release.jks with its passwords in
// android/keystore.properties. Neither is committed: keep both, because an
// update only installs over an app signed with the same key.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const android = path.join(root, 'android');
const debug = process.argv.includes('debug');
const windows = process.platform === 'win32';
const { version } = JSON.parse(
  fs.readFileSync(path.join(root, 'package.json'), 'utf-8'),
);

function firstExisting(candidates) {
  return candidates.find((candidate) => candidate && fs.existsSync(candidate));
}

// ---- Java: JAVA_HOME, or the one inside Android Studio
const javaHome = firstExisting([
  process.env.JAVA_HOME,
  'C:\\Program Files\\Android\\Android Studio\\jbr',
  '/Applications/Android Studio.app/Contents/jbr/Contents/Home',
  '/opt/android-studio/jbr',
  path.join(os.homedir(), 'android-studio', 'jbr'),
]);
if (!javaHome) {
  console.error('No Java found: install Android Studio or set JAVA_HOME.');
  process.exit(1);
}

// ---- the Android SDK, written to android/local.properties
const sdk = firstExisting([
  process.env.ANDROID_HOME,
  process.env.ANDROID_SDK_ROOT,
  process.env.LOCALAPPDATA &&
    path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk'),
  path.join(os.homedir(), 'Library', 'Android', 'sdk'),
  path.join(os.homedir(), 'Android', 'Sdk'),
]);
if (!sdk) {
  console.error('No Android SDK found: install it with Android Studio.');
  process.exit(1);
}
fs.writeFileSync(
  path.join(android, 'local.properties'),
  `sdk.dir=${sdk.replaceAll('\\', '/')}\n`,
);

const env = { ...process.env, JAVA_HOME: javaHome };
// Through the shell on Windows (for npx and .bat files): quote paths there.
const run = (command, args, cwd = root) =>
  execFileSync(
    windows && command.includes(' ') ? `"${command}"` : command,
    args,
    {
      cwd,
      env,
      stdio: 'inherit',
      shell: windows,
    },
  );

// ---- the release signing key, made once
const keystoreProperties = path.join(android, 'keystore.properties');
if (!debug && !fs.existsSync(keystoreProperties)) {
  const password = crypto.randomBytes(18).toString('base64url');
  const keytool = path.join(
    javaHome,
    'bin',
    windows ? 'keytool.exe' : 'keytool',
  );
  run(keytool, [
    '-genkeypair',
    '-keystore',
    path.join(android, 'terra-release.jks'),
    '-alias',
    'terra',
    '-keyalg',
    'RSA',
    '-keysize',
    '4096',
    '-validity',
    '10000',
    '-storepass',
    password,
    '-keypass',
    password,
    '-dname',
    'CN=Terra',
  ]);
  fs.writeFileSync(
    keystoreProperties,
    [
      'storeFile=terra-release.jks',
      `storePassword=${password}`,
      'keyAlias=terra',
      `keyPassword=${password}`,
      '',
    ].join('\n'),
  );
  console.log('Made a signing key: android/terra-release.jks (keep it).');
}

// ---- build
run('npx', ['vite', 'build']);
run(
  path.join(android, windows ? 'gradlew.bat' : 'gradlew'),
  [debug ? 'assembleDebug' : 'assembleRelease', '--console=plain'],
  android,
);

const variant = debug ? 'debug' : 'release';
const built = path.join(
  android,
  'app',
  'build',
  'outputs',
  'apk',
  variant,
  `app-${variant}.apk`,
);
const out = path.join(root, 'out');
fs.mkdirSync(out, { recursive: true });
const target = path.join(out, `Terra-${version}${debug ? '-debug' : ''}.apk`);
fs.copyFileSync(built, target);
console.log(`\nAPK: ${target}`);
