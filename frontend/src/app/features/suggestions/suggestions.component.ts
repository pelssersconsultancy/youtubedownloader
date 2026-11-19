import { Component, inject, signal, computed, OnInit } from '@angular/core';
import { AppStateService } from '../../core/services/app-state.service';
import { ChannelApiService } from '../../core/services/channel-api.service';
import type { Suggestion, SuggestionSection } from '../../core/models/channel.model';

@Component({
  selector: 'app-suggestions',
  standalone: true,
  template: `
    <section class="suggestions-page">
      <p>
        {{
          t(
            'Browse verified YouTube channels from the self-reliance skills guide. Add a channel to My Channels to bookmark it; auto-sync remains off until you enable it there.',
            'Bekijk gecontroleerde YouTube-kanalen uit de gids voor zelfredzaamheid. Voeg een kanaal toe aan Mijn kanalen om het te bewaren; auto-sync blijft uit totdat je die daar aanzet.'
          )
        }}
      </p>
      <div class="bar tools">
        <input
          type="search"
          [placeholder]="t('Search suggested channels', 'Zoek voorgestelde kanalen')"
          [value]="query()"
          (input)="query.set($any($event.target).value)"
        />
      </div>
      @if (loading()) {
        <p class="count">{{ t('Loading suggestions…', 'Suggesties laden…') }}</p>
      }
      @for (section of filtered(); track section.title) {
        <section class="suggestion-section">
          <h2>{{ section.title }}</h2>
          @for (subsection of section.subsections; track subsection.title) {
            <section class="suggestion-subsection">
              <h3>{{ subsection.title }}</h3>
              <div class="suggestion-list">
                @for (suggestion of subsection.channels; track suggestion.url) {
                  <article class="suggestion-item">
                    <div class="suggestion-info">
                      <h4>{{ suggestion.title }}</h4>
                    </div>
                    <a
                      class="suggestion-link"
                      [href]="suggestion.url"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      YouTube &#8599;
                    </a>
                    <button
                      type="button"
                      [disabled]="isAdded(suggestion) || addingUrl() !== null"
                      (click)="add(suggestion)"
                    >
                      {{
                        isAdded(suggestion)
                          ? t('Added to My Channels', 'Toegevoegd aan Mijn kanalen')
                          : addingUrl() === suggestion.url
                            ? t('Adding…', 'Toevoegen…')
                            : t('Add to my Channels', 'Toevoegen aan Mijn kanalen')
                      }}
                    </button>
                  </article>
                }
              </div>
            </section>
          }
        </section>
      } @empty {
        @if (!loading()) {
          <p class="empty">{{ t('No matching suggestions.', 'Geen passende suggesties.') }}</p>
        }
      }
      @if (error()) {
        <p class="error" role="alert">{{ error() }}</p>
      }
    </section>
  `,
  styles: [
    `
      .suggestions-page > p {
        color: #8d9db7;
        font-size: 13px;
      }
      .suggestion-section {
        margin-top: 26px;
        padding: 16px;
        border: 1px solid rgba(72, 217, 255, 0.2);
        border-radius: 14px;
        background: linear-gradient(145deg, rgba(18, 44, 70, 0.48), rgba(13, 20, 38, 0.64));
        box-shadow: 0 12px 34px rgba(0, 0, 0, 0.12);
      }
      .suggestion-section > h2 {
        margin: 0 0 18px;
        padding: 12px 15px;
        border-left: 4px solid #48d9ff;
        border-radius: 7px;
        background: linear-gradient(90deg, rgba(44, 151, 190, 0.2), rgba(24, 83, 126, 0.07));
        color: #7ce7ff;
        font-size: 21px;
        letter-spacing: 0.01em;
      }
      .suggestion-subsection {
        margin: 18px 0 0 10px;
        padding-left: 14px;
        border-left: 2px solid rgba(182, 124, 255, 0.5);
      }
      .suggestion-subsection > h3 {
        margin: 0 0 10px;
        padding: 9px 13px;
        border: 1px solid rgba(182, 124, 255, 0.2);
        border-radius: 8px;
        background: linear-gradient(90deg, rgba(106, 62, 155, 0.24), rgba(58, 39, 93, 0.12));
        color: #d8bcff;
        font-size: 14px;
        font-weight: 600;
      }
      .suggestion-list {
        display: grid;
        gap: 8px;
      }
      .suggestion-item {
        display: grid;
        grid-template-columns: minmax(180px, 1fr) minmax(90px, 150px) auto;
        gap: 14px;
        align-items: center;
        padding: 13px 15px;
        border: 1px solid rgba(129, 164, 220, 0.12);
        border-radius: 10px;
        background: rgba(16, 24, 43, 0.78);
      }
      .suggestion-info {
        min-width: 0;
      }
      .suggestion-info h4 {
        margin: 0;
        font-size: 14px;
        font-weight: 600;
      }
      .suggestion-link {
        color: #73dfff;
        font-size: 12px;
        text-decoration: none;
      }
      .suggestion-link:hover {
        text-decoration: underline;
      }
      @media (max-width: 600px) {
        .suggestion-section > h2 { font-size: 18px; }
        .suggestion-section { padding: 12px 9px; }
        .suggestion-subsection { margin-left: 4px; padding-left: 9px; }
        .suggestion-item { grid-template-columns: minmax(0, 1fr); }
        .suggestion-link, .suggestion-item button { grid-column: auto; grid-row: auto; }
      }
    `,
  ],
})
export class SuggestionsComponent implements OnInit {
  appState = inject(AppStateService);
  private channelApi = inject(ChannelApiService);

  query = signal('');
  suggestions = signal<SuggestionSection[]>([]);
  loading = signal(false);
  addingUrl = signal<string | null>(null);
  error = signal('');

  filtered = computed(() => {
    const q = this.query().trim().toLocaleLowerCase();
    if (!q) return this.suggestions();
    return this.suggestions()
      .map((section) => {
        const sectionMatches = section.title.toLocaleLowerCase().includes(q);
        const subsections = section.subsections
          .map((sub) => ({
            ...sub,
            channels: sub.channels.filter(
              (c) =>
                sectionMatches ||
                sub.title.toLocaleLowerCase().includes(q) ||
                c.title.toLocaleLowerCase().includes(q),
            ),
          }))
          .filter((sub) => sub.channels.length);
        return { ...section, subsections };
      })
      .filter((s) => s.subsections.length);
  });

  ngOnInit() {
    this.appState.loadChannels();
    this.load();
  }

  t(english: string, dutch: string) {
    return this.appState.t(english, dutch);
  }

  isAdded(suggestion: Suggestion) {
    return this.appState.channels().some((c) => c.url === suggestion.url);
  }

  load() {
    this.loading.set(true);
    this.channelApi.getSuggestions().subscribe({
      next: (s) => {
        this.suggestions.set(s);
        this.loading.set(false);
      },
      error: () => {
        this.loading.set(false);
        this.error.set(
          this.t(
            'Could not load channel suggestions.',
            'Kan de kanaalsuggesties niet laden.',
          ),
        );
      },
    });
  }

  add(suggestion: Suggestion) {
    if (this.isAdded(suggestion) || this.addingUrl()) return;
    this.addingUrl.set(suggestion.url);
    this.error.set('');
    this.channelApi.addChannel(suggestion.url).subscribe({
      next: (result) => {
        this.appState.channels.set(result.channels);
        this.addingUrl.set(null);
      },
      error: (e) => {
        this.error.set(
          e.error?.message ??
            this.t('Could not add this channel.', 'Dit kanaal toevoegen is mislukt.'),
        );
        this.addingUrl.set(null);
      },
    });
  }
}
