import { PATCH_NOTES } from "../../data/patchnotes";

export function PatchNotes() {
  return (
    <div class="hub-notes">
      {PATCH_NOTES.map((p) => (
        <section class="hub-panel">
          <h2>
            v{p.version} {p.title}
            <span class="hub-notes-date">{p.date}</span>
          </h2>
          <ul class="hub-notes-list">
            {p.notes.map((n) => (
              <li>{n}</li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
