"""Finite local browser verification for the Shooty interactive blueprint.

Uses an existing Chromium binary and closes only its own browser instance.
No HTTP server, wallet connection, BLE service, or chain transaction is started.
"""

import json
from pathlib import Path
from datetime import datetime, timezone
from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parent


def main():
    candidates = sorted((Path.home() / '.cache/ms-playwright').glob('chromium-*/chrome-linux64/chrome'))
    if not candidates:
        raise RuntimeError('An installed Chromium executable is required; none was downloaded.')
    browser_path = candidates[-1]
    economics = json.loads((ROOT / 'economics.json').read_text())
    errors = []
    network = []
    checks = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=str(browser_path), headless=True)
        try:
            page = browser.new_page(viewport={'width': 1440, 'height': 1100}, device_scale_factor=1)
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.on('request', lambda request: network.append(request.url) if request.url.startswith(('https://', 'http://')) else None)
            page.goto((ROOT / 'index.html').as_uri())
            page.wait_for_function('Boolean(window.ShootyBlueprint)')
            embedded = page.evaluate('window.ShootyBlueprint.SPEC')
            assert embedded['modes'] == economics['modes']
            assert embedded['entryUnits'] == economics['entryUnits']
            assert embedded['feeBps'] == economics['feeBps']
            checks.append('Embedded frontend economics match the canonical JSON')

            for mode, quote in economics['modes'].items():
                page.locator(f'[data-mode="{mode}"]').click()
                page.locator('[data-action="next"]').click()
                page.locator('[data-action="connect"]').click()
                page.locator('[data-action="sign"]').click()
                page.locator('[data-action="touch"]').click()
                assert page.evaluate('window.ShootyBlueprint.state.control') == 'touch'
                page.locator('[data-action="next"]').click()
                assert page.locator('#actual-deposit').inner_text() == '0.00'
                page.locator('[data-action="approve"]').click()
                assert page.locator('#actual-deposit').inner_text() == '0.00'
                page.locator('[data-action="deposit"]').click()
                assert page.locator('#actual-deposit').inner_text() == '1.00'
                page.locator('[data-action="fundOthers"]').click()
                assert page.locator('#actual-deposit').inner_text() == f"{quote['players']:.2f}"
                page.locator('[data-action="next"]').click()
                assert page.locator('[data-action="fire"]').is_disabled()
                page.locator('[data-action="signal"]').click()
                for _ in range(3):
                    page.locator('[data-action="fire"]').click()
                assert page.evaluate('window.ShootyBlueprint.state.step') == 6
                assert page.locator('#locked').inner_text() == '0.00'
                assert page.locator('#credits').inner_text() == f"{quote['players']:.2f}"
                assert page.locator('#sent').inner_text() == '0.00'
                page.locator('[data-action="next"]').click()
                assert page.locator('#credits').inner_text() == '0.00'
                assert page.locator('#sent').inner_text() == f"{quote['players']:.2f}"
                page.locator('[data-action="receipt"]').click()
                receipt = json.loads(page.locator('#receipt-content').inner_text())
                assert receipt['myReceivedTestUSDC'] == f"{quote['perWinnerUnits'] / 1_000_000:.2f}"
                assert receipt['simulation'] is True
                page.locator('#receipt button').click()
                page.locator('[data-action="rematch"]').click()
                assert page.locator('#actual-deposit').inner_text() == '0.00'
                checks.append(f'{mode}: login, approval, deposit, game, credit, payout, and fresh rematch')

                for outcome in ('win', 'lose', 'draw', 'timeout'):
                    page.locator('#scenario').select_option(outcome)
                    page.locator('[data-step="6"]').click()
                    expected_deposit = 1 if outcome == 'timeout' else quote['players']
                    assert page.locator('#credits').inner_text() == f'{expected_deposit:.2f}'
                    page.locator('[data-action="next"]').click()
                    page.locator('[data-action="receipt"]').click()
                    data = json.loads(page.locator('#receipt-content').inner_text())
                    expected_payment = quote['perWinnerUnits'] / 1_000_000 if outcome == 'win' else (0 if outcome == 'lose' else 1)
                    assert data['myReceivedTestUSDC'] == f'{expected_payment:.2f}'
                    page.locator('#receipt button').click()
                    checks.append(f'{mode}/{outcome}: simulated credit and payment amounts consistent')
                page.locator('[data-action="reset"]').click()

            page.locator('[data-mode="DUEL"]').click()
            page.screenshot(path=str(ROOT / 'preview-desktop.png'), full_page=True)
            for width in (360, 390, 768, 1440):
                page.set_viewport_size({'width': width, 'height': 900})
                for mode in economics['modes']:
                    page.locator(f'[data-mode="{mode}"]').click()
                    for step in (0, 2, 3, 6, 7):
                        page.locator(f'[data-step="{step}"]').click()
                        assert not page.evaluate('document.documentElement.scrollWidth > window.innerWidth'), (width, mode, step)
                checks.append(f'No document overflow at {width}px for key screens in all modes')
            page.set_viewport_size({'width': 390, 'height': 844})
            page.locator('[data-mode="DUEL"]').click()
            page.locator('[data-step="7"]').click()
            page.locator('.phone').screenshot(path=str(ROOT / 'preview-mobile.png'))
            assert not errors, errors
            assert not network, network
        finally:
            browser.close()

    result = {
        'checked_at': datetime.now(timezone.utc).isoformat(),
        'browser_executable': str(browser_path),
        'checks': checks,
        'browser_errors': errors,
        'external_http_requests': network,
        'notice': 'Local UI simulation checks only; no live wallet, BLE, escrow, or chain settlement tested.',
        'browser_closed': True,
    }
    (ROOT / 'preview-verification.json').write_text(json.dumps(result, indent=2))
    print(json.dumps({'passed': len(checks), 'browser_errors': len(errors), 'external_requests': len(network), 'browser_closed': True}, indent=2))


if __name__ == '__main__':
    main()
