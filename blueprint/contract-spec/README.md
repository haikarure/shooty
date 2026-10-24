**Verifikasi bagian kontrak blueprint Shooty.**

Folder ini memuat interface dan matematika yang dapat dikompilasi. Belum ada implementation escrow, deployment script, atau deployment testnet. File generated adalah salinan identik hasil MCP di ../openzeppelin; token LOCALUSD dipakai sebagai template lokal dan bukan USDC Circle.

Dependency OpenZeppelin dikunci pada 5.6.1 melalui package-lock.json. Instalasi tidak menjalankan lifecycle scripts:

```bash
npm ci --ignore-scripts --no-audit --no-fund
forge test
```

Untuk verifikasi pekerjaan ini digunakan Foundry 1.7.1 dan solc lokal 0.8.36. Jika solc tidak ditemukan secara otomatis, berikan executable yang sesuai dengan `forge test --use /path/to/solc`. Target EVM pengujian adalah Cancun, bukan benchmark jadwal gas Monad. Biaya gas pada output test tidak boleh dipromosikan sebagai biaya deployment atau transaksi testnet aktual.

PayoutMath mengunci entry 1.000.000 unit dan fee 1.000 basis points. Mode 0/1/2 berarti Duel/Team Duel/Rumble empat pemain. Refund memakai mask depositor yang benar-benar membayar dan tidak mengambil fee. Interface di src/IShootyArena.sol merupakan kontrak integrasi usulan; source tersebut tidak menyimpan token.

Hasil test dan metadata compiler dicatat di ../verification.json setelah verifikasi. Definisi state, deadline, otorisasi, serta konservasi liabilities ada pada [blueprint utama](../README.md).
