// import { treasury } from "./types/sui/0x6951ee690a25857df1652cd7cd8d412913cca01ee03d87cfa1edb2db06acef24.js";
import { SuiNetwork } from "@sentio/sdk/sui";
import { treasury } from "./types/sui/testnet/0x325aef14e2ed83759a2969f9f9cbffca206430c2de658ec61a20866bb3f6fd51.js";


treasury.bind({
  network: SuiNetwork.TEST_NET,
  startCheckpoint: 127311700n
})
  .onEventMintEvent(async (event, ctx) => {
    const amount = event.data_decoded.amount
    const to = event.data_decoded.to
    ctx.eventLogger.emit("MintEvent", {
      distinctId: to,
      amount,
      to
    })
    ctx.meter.Gauge("MintGauge").record(amount)
    ctx.meter.Counter("MintCounter").add(amount)
  })
  .onEventBurnEvent(async (event, ctx) => {
    const amount = event.data_decoded.amount
    const from = event.data_decoded.from
    ctx.eventLogger.emit("BurnEvent", {
      distinctId: from,
      amount,
      from
    })
    ctx.meter.Gauge("BurnGauge").record(amount)
    ctx.meter.Counter("BurnCounter").add(amount)
  })
  .onTransactionBlock(async (tx, ctx) => {
    ctx.eventLogger.emit("ontxb", {
      tx: tx.digest
    })
  })

