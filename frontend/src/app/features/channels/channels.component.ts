import { Component, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { AppStateService } from '../../core/services/app-state.service';
import { ChannelApiService } from '../../core/services/channel-api.service';
import type { Channel } from '../../core/models/channel.model';

@Component({
  selector: 'app-channels',
  standalone: true,
  template: `
    <section class="channels-page">
      <p>
        {{
          t(
            'Add a channel to scan and sync new videos.',
            "Voeg een kanaal toe om nieuwe video's te scannen en te synchroniseren."
          )
        }}
      </p>
      <p class="reorder-hint">
        <strong>{{ t('Change sync order:', 'Syncvolgorde wijzigen:') }}</strong>
        {{
          t(
            'Drag a channel using the ⠿ handle. Channels higher in the list are synced first; active downloads are not interrupted.',
            'Sleep een kanaal met het ⠿-handvat omhoog of omlaag. Kanalen hoger in de lijst krijgen eerst voorrang; lopende downloads worden niet onderbroken.'
          )
        }}
      </p>
      <form class="bar" (submit)="$event.preventDefault(); addChannel()">
        <input
          type="url"
          placeholder="https://www.youtube.com/@channelname"
          [value]="channelUrl()"
          (input)="channelUrl.set($any($event.target).value)"
        />
        <button type="submit" [disabled]="addingChannel() || !channelUrl().trim()">
          {{ t('Add channel', 'Kanaal toevoegen') }}
        </button>
      </form>
      @if (scanMessage()) {
        <p class="count">{{ scanMessage() }}</p>
      }
      <ul class="channel-list">
        @for (channel of appState.channels(); track channel.url) {
          <li
            class="channel-item"
            draggable="true"
            [class.dragging]="draggedUrl() === channel.url"
            (dragstart)="startDrag(channel, $event)"
            (dragover)="$event.preventDefault()"
            (drop)="drop(channel, $event)"
            (dragend)="draggedUrl.set(null)"
          >
            <span
              class="drag-handle"
              [attr.title]="t('Drag to change sync order', 'Sleep om de syncvolgorde te wijzigen')"
              aria-hidden="true"
            >
              &#10783;
            </span>
            <button type="button" class="channel-main" (click)="openChannel(channel)">
              <strong>{{ channel.title }}</strong><small>{{ channel.url }}</small>
            </button>
            <label class="autosync-toggle">
              <input
                type="checkbox"
                [checked]="channel.autoSync"
                [disabled]="syncingUrl() === channel.url"
                (change)="toggleAutoSync(channel, $any($event.target).checked)"
              />
              <span>{{ t('Auto-sync', 'Auto-sync') }}</span>
            </label>
            <button type="button" class="danger" (click)="removeChannel(channel)">
              {{ t('Remove', 'Verwijderen') }}
            </button>
          </li>
        } @empty {
          @if (!addingChannel()) {
            <li class="empty">
              {{
                t(
                  'You have not bookmarked any channels yet.',
                  'Je hebt nog geen kanalen gebookmarkt.'
                )
              }}
            </li>
          }
        }
      </ul>
      @if (error()) {
        <p class="error" role="alert">{{ error() }}</p>
      }
    </section>
  `,
  styles: [
    `
      .channels-page > p {
        color: #8d9db7;
        font-size: 13px;
      }
      .channels-page > .reorder-hint {
        margin: 10px 0 18px;
        padding: 10px 12px;
        border: 1px solid rgba(72, 217, 255, 0.15);
        border-left: 2px solid var(--accent);
        border-radius: 0 9px 9px 0;
        background: rgba(29, 82, 111, 0.13);
        color: #b5c8e2;
      }
      .channel-list {
        margin-top: 20px;
      }
      .channel-item {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 12px;
        min-height: 67px;
        border-color: rgba(129, 164, 220, 0.11);
      }
      .channel-item[draggable='true'] {
        cursor: grab;
      }
      .channel-item.dragging {
        opacity: 0.45;
      }
      .drag-handle {
        flex: 0 0 auto;
        color: #6f82a2;
        font-size: 22px;
        cursor: grab;
        user-select: none;
      }
      .channel-main {
        flex: 1;
        min-width: 0;
        display: block;
        padding: 4px;
        border: 0;
        background: transparent;
        color: inherit;
        text-align: left;
        border-radius: 7px;
      }
      .channel-main:hover {
        background: rgba(72, 217, 255, 0.055);
      }
      .channel-item strong {
        display: block;
        overflow: hidden;
        text-overflow: ellipsis;
        font-size: 13px;
        font-weight: 600;
      }
      .channel-item small {
        display: block;
        overflow: hidden;
        text-overflow: ellipsis;
        color: #71819d;
        font: 10px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
      }
      .autosync-toggle {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        white-space: nowrap;
        cursor: pointer;
      }
      .autosync-toggle input {
        appearance: none;
        position: relative;
        width: 40px;
        height: 23px;
        margin: 0;
        border: 0;
        border-radius: 999px;
        background: var(--line);
        cursor: pointer;
        transition: background-color 120ms ease;
      }
      .autosync-toggle input::before {
        content: '';
        position: absolute;
        top: 3px;
        left: 3px;
        width: 17px;
        height: 17px;
        border-radius: 50%;
        background: #fff;
        box-shadow: 0 1px 2px rgb(0 0 0 / 25%);
        transition: transform 120ms ease;
      }
      .autosync-toggle input:checked {
        background: var(--accent);
      }
      .autosync-toggle input:checked::before {
        transform: translateX(17px);
      }
      @media (max-width: 600px) {
        .channel-item { flex-wrap: wrap; gap: 6px; padding: 10px 8px; }
        .channel-main { flex-basis: calc(100% - 44px); }
        .autosync-toggle { margin-left: 30px; font-size: 11px; }
        .channel-item .danger { margin-left: auto; padding: 7px 9px; font-size: 10px; }
      }
    `,
  ],
})
export class ChannelsComponent {
  appState = inject(AppStateService);
  private channelApi = inject(ChannelApiService);
  private router = inject(Router);

  channelUrl = signal('');
  addingChannel = signal(false);
  scanMessage = signal('');
  syncingUrl = signal('');
  draggedUrl = signal<string | null>(null);
  reordering = signal(false);
  error = signal('');

  t(english: string, dutch: string) {
    return this.appState.t(english, dutch);
  }

  openChannel(channel: Channel) {
    this.router.navigate(['/channel'], { queryParams: { url: channel.url } });
  }

  addChannel() {
    const url = this.channelUrl().trim();
    if (!url) return;
    this.addingChannel.set(true);
    this.syncingUrl.set(url);
    this.error.set('');
    this.scanMessage.set('');
    this.channelApi.addChannel(url).subscribe({
      next: (result) => {
        this.appState.channels.set(result.channels);
        this.channelUrl.set('');
        this.scanMessage.set(
          this.t(
            'Channel added. Auto-sync is off by default.',
            'Kanaal toegevoegd. Auto-sync staat standaard uit.',
          ),
        );
        this.addingChannel.set(false);
        this.syncingUrl.set('');
      },
      error: (e) => {
        this.error.set(
          e.error?.message ?? this.t('Could not add the channel.', 'Kanaal toevoegen is mislukt.'),
        );
        this.addingChannel.set(false);
        this.syncingUrl.set('');
      },
    });
  }

  toggleAutoSync(channel: Channel, enabled: boolean) {
    this.syncingUrl.set(channel.url);
    this.error.set('');
    this.channelApi.setAutoSync(channel.url, enabled).subscribe({
      next: (result) => {
        this.appState.channels.set(result.channels);
        this.scanMessage.set(
          enabled
            ? this.t(
                `${result.scanned} videos checked. Undownloaded videos were added to the sync queue.`,
                `${result.scanned} video's gecontroleerd. Niet gedownloade video's zijn in de syncwachtrij gezet.`,
              )
            : this.t('Auto-sync is off.', 'Auto-sync staat uit.'),
        );
        this.syncingUrl.set('');
      },
      error: (e) => {
        this.error.set(
          e.error?.message ??
            this.t(
              'Could not save the auto-sync setting.',
              'Auto-sync-instelling opslaan is mislukt.',
            ),
        );
        this.syncingUrl.set('');
      },
    });
  }

  removeChannel(channel: Channel) {
    this.channelApi.removeChannel(channel.url).subscribe({
      next: (channels) => this.appState.channels.set(channels),
      error: () =>
        this.error.set(
          this.t('Could not remove the channel.', 'Kanaal verwijderen is mislukt.'),
        ),
    });
  }

  startDrag(channel: Channel, event: DragEvent) {
    this.draggedUrl.set(channel.url);
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', channel.url);
    }
  }

  drop(target: Channel, event: DragEvent) {
    event.preventDefault();
    const sourceUrl = this.draggedUrl() ?? event.dataTransfer?.getData('text/plain');
    if (!sourceUrl || sourceUrl === target.url || this.reordering()) return;
    const previous = this.appState.channels();
    const reordered = [...previous];
    const sourceIndex = reordered.findIndex((c) => c.url === sourceUrl);
    if (sourceIndex < 0) return;
    reordered.splice(sourceIndex, 1);
    const targetIndex = reordered.findIndex((c) => c.url === target.url);
    const targetBounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const dropAfter = event.clientY > targetBounds.top + targetBounds.height / 2;
    reordered.splice(targetIndex + (dropAfter ? 1 : 0), 0, previous[sourceIndex]);
    this.appState.channels.set(reordered);
    this.reordering.set(true);
    this.channelApi.reorderChannels(reordered.map((c) => c.url)).subscribe({
      next: (channels) => {
        this.appState.channels.set(channels);
        this.reordering.set(false);
      },
      error: () => {
        this.appState.channels.set(previous);
        this.reordering.set(false);
        this.error.set(
          this.t('Could not save the channel order.', 'Kanaalvolgorde opslaan is mislukt.'),
        );
      },
    });
  }
}
