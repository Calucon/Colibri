import { Routes } from '@angular/router';
import { LogComponent } from './app/pages/log/log.component';
import { StatisticsComponent } from './app/pages/statistics/statistics.component';

export const routes: Routes = [
    { path: 'log', component: LogComponent, title: 'Log · Colibri' },
    { path: 'statistics', component: StatisticsComponent, title: 'Statistics · Colibri' },
    { path: '**', redirectTo: '/log' },
];
