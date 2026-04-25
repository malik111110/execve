export function renderPolicySelector(): string {
  return `
            <label class="approval-picker" for="approval-mode">
              <span class="picker-label">Approvals</span>
              <select id="approval-mode" aria-label="Approval mode">
                <option value="defaultApproval">Default Approvals</option>
                <option value="bypassApproval">Bypass Approvals</option>
                <option value="autopilot">Autopilot</option>
              </select>
            </label>`;
}
