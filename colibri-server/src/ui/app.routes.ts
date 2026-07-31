import { Routes } from '@angular/router';
import { LogComponent } from './app/pages/log/log.component';
import { StatisticsComponent } from './app/pages/statistics/statistics.component';

export const routes: Routes = [
    { path: 'log', component: LogComponent },
    { path: 'statistics', component: StatisticsComponent },
    { path: '**', redirectTo: '/log' },
];
