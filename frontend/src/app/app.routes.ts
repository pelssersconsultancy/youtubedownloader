import { Routes } from '@angular/router';
import { OverviewComponent } from './features/overview/overview.component';
import { ChannelsComponent } from './features/channels/channels.component';
import { SuggestionsComponent } from './features/suggestions/suggestions.component';
import { SyncProgressComponent } from './features/sync-progress/sync-progress.component';
import { ChannelImportComponent } from './features/channel-import/channel-import.component';

export const routes: Routes = [
  { path: '', redirectTo: 'overview', pathMatch: 'full' },
  { path: 'overview', component: OverviewComponent },
  { path: 'channels', component: ChannelsComponent },
  { path: 'suggestions', component: SuggestionsComponent },
  { path: 'sync', component: SyncProgressComponent },
  { path: 'channel', component: ChannelImportComponent },
];
