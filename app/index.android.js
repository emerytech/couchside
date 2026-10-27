// Android entry. Register the home-screen widget's headless task handler BEFORE
// Expo Router loads, so the widget renders even when the app is closed (the
// widget's background task runs this same bundle entry). Then hand off to Expo
// Router exactly as the default entry does — `require` last so registration is
// guaranteed to run first.
import { registerWidgetTaskHandler } from 'react-native-android-widget';

import { widgetTaskHandler } from './lib/widget/widgetTaskHandler';

registerWidgetTaskHandler(widgetTaskHandler);

require('expo-router/entry');
