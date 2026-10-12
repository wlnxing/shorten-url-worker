import { createApp } from 'vue';
import App from './App.vue';
import { themeVariables } from './theme';
import 'ant-design-vue/dist/reset.css';
import './style.css';
for (const [name, value] of Object.entries(themeVariables)) {
  document.documentElement.style.setProperty(name, value);
}
createApp(App).mount('#app');
