import { Routes } from '@angular/router';
import { LogComponent } from './app/pages/log/log.component';
import { StatisticsComponent } from './app/pages/statistics/statistics.component';
import { ServerComponent } from './app/pages/server/server.component';

// One segment each: the production build's <base href="./"> resolves against the page's path.
export const routes: Routes = [
    { path: 'log', component: LogComponent, title: 'Log · Colibri' },
    { path: 'statistics', component: StatisticsComponent, title: 'Statistics · Colibri' },
    { path: 'server', component: ServerComponent, title: 'Server · Colibri' },
    { path: '**', redirectTo: '/log' },
];
