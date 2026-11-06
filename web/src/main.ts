import { createApp } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import App from './App.vue';
import './style.css';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: () => import('./views/OverviewView.vue') },
    { path: '/leads', component: () => import('./views/LeadsView.vue') },
    { path: '/leads/:id', component: () => import('./views/LeadDetailView.vue'), props: true },
    { path: '/discovery', component: () => import('./views/DiscoveryView.vue') },
    { path: '/inbox', component: () => import('./views/InboxView.vue') },
    { path: '/approval', component: () => import('./views/ApprovalView.vue') },
    { path: '/templates', component: () => import('./views/TemplatesView.vue') },
    { path: '/knowledge', component: () => import('./views/KnowledgeView.vue') },
    { path: '/do-not-contact', component: () => import('./views/SuppressionsView.vue') },
    { path: '/tasks', component: () => import('./views/TasksView.vue') },
    { path: '/logs', component: () => import('./views/LogsView.vue') },
    { path: '/settings', component: () => import('./views/SettingsView.vue') },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
});

createApp(App).use(router).mount('#app');
