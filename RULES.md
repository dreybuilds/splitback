# RULES

These rules were written before the contract. The contract in `contracts/splitback` implements them and nothing else.

## Vocabulary

| Term | Meaning |
|---|---|
| Task | A deterministic piece of work, described by a short spec string. Its **task key** is the SHA-256 of that spec. |
| Result | The bytes a task produces. Only its SHA-256 (**result hash**) goes on chain. |
| Entry | One published result for one task: task key, result hash, cost, publisher, bond. |
| Cost `C` | What the publisher says the result cost to produce, in the smallest unit of the payment token. It is the publisher's ask, not a verified fact. |
| Holder | An account with the right to the result. The publisher is holder number 1. |
| `k` | The number of holders of an entry, publisher included. |
| Share | `ceil(C / k)`. What every holder has paid, net, once rebates are claimed. |
| Bond | Tokens the publisher locks at publish time. Always `2 × C`. |
| Provider | Optional. The account that did the work for the publisher. If named, the publisher pays it `C` inside the same call. |
| Verifiers | The committee that rules on challenges: a fixed list of accounts and a threshold that is a strict majority. In the scripted demo they are agents that recompute the task. In `sim/judge.mjs` they are agents backed by three different models on NEAR AI Cloud. |

## The rules

1. **Prepaid balances.** Agents hold a token balance inside the contract. A balance is credited by `ft_transfer_call` on the token, and anyone may fund any account. All prices are debited from this balance, so a purchase is one transaction with no token transfer.
2. **Publish.** A publisher records `(task key, spec, result hash, C)` and the contract locks a bond of `2 × C` from the publisher's balance. The publisher becomes holder 1 and is treated as having paid `C`. If the publisher names a provider, the contract also moves `C` from the publisher to the provider in the same call, so the cost is a payment the chain saw.
3. **Join.** A buyer joins an open entry by paying `ceil(C / (k + 1))`. `k` then increases by one. The buyer may pass a `max_price`; the call fails if the price is higher.
4. **Rebate.** At any time a holder may claim `paid − ceil(C / k) − already claimed`. After claiming, every holder's net cost is exactly `ceil(C / k)`, whenever they joined. Joining early is never punished.
5. **Solvency.** Buyers pay in `sum of ceil(C / j)` for `j = 2..k`. Holders are owed at most `C + that sum − k × ceil(C / k)`. Because `k × ceil(C / k) ≥ C`, the pool always covers what is owed. Rounding dust (less than `k` units per entry) stays in the contract.
6. **Several entries per task.** Anyone may publish a competing entry for the same task key at a lower `C`. Buyers choose. An inflated `C` is undercut.
7. **Challenge.** Anyone may challenge an open or retired entry by staking `ceil(C / 10)`. One challenge at a time per entry.
8. **Vote.** Each verifier votes once per challenge, to uphold or to reject. The challenge is decided the moment either side reaches the threshold. Because the threshold is a strict majority, both sides can never reach it.
   - **Upheld:** the entry is void. Every buyer may claim back everything they paid net of rebates. The forfeit is the bond minus whatever the publisher had already claimed in rebates. The challenger gets their stake back plus the forfeit, less the verifiers' cut. The publisher gets nothing further.
   - **Rejected:** the forfeit is the stake. It goes to the publisher, less the verifiers' cut, and the entry returns to its previous state.
   - **Verifiers' cut:** a tenth of the forfeit, split equally among the verifiers who voted with the outcome. A verifier who voted against it, or did not vote, gets nothing.
   - **No decision:** if the threshold is not reached within the challenge window, anyone may lapse the challenge. The stake returns to the challenger, the entry returns to its previous state, and nobody is punished. Offline verifiers cannot freeze an entry.
9. **Why the bond is `2 × C`.** The only money that can have left an entry's pool to someone who must not keep it is the publisher's claimed rebates, which are always less than `C`. A bond of `C` would make buyers whole, but a caught publisher would then lose only `C / k`, which shrinks as buyers join. With `2 × C` a caught publisher always loses more than `C`, and the challenger's reward is at least `0.9 × C`.
10. **Retire and release.** The publisher may retire an entry, which stops new joins. Once the challenge window has passed since the last join or rejected challenge, and no challenge is pending, the publisher may take the bond back. Holders can still claim rebates afterwards. An entry whose bond has been released can no longer be challenged.
11. **Withdraw.** Any account may withdraw its balance to itself as tokens.

## One round, as a sequence

```
Publisher P        Buyer B1          Buyer B2         Contract                Verifier V
    |                 |                 |                 |                        |
    |-- compute task off chain (cost C = 900) ----------->|                        |
    |-- publish(key, hash, C=900) ----------------------->| lock bond 1800, k=1    |
    |                 |-- quote(entry) ------------------>| next price 450         |
    |                 |-- join(entry, max 450) ---------->| B1 pays 450, k=2       |
    |<= result bytes served to B1 off chain; B1 checks sha256 == result hash       |
    |-- claim(entry) ------------------------------------>| P gets 900-450 = 450   |
    |                 |                 |-- join -------->| B2 pays 300, k=3       |
    |-- claim ------------------------------------------->| P gets 150 more        |
    |                 |-- claim ------------------------->| B1 gets 450-300 = 150  |
    |        everyone has now paid 300 net                |                        |
    |                 |                 |-- challenge --->| stake 90, frozen state |
    |                 |                 |                 |<-- 3 verifiers recompute and vote; 2 decide
    |                 |                 |   upheld: B1, B2 refunded in full;        |
    |                 |                 |   B2 gets stake + 90% of (1800 - 600);    |
    |                 |                 |   the two upholding verifiers split 10%   |
```

## The case against this idea

A result is just bytes. Once one agent holds it, nothing on chain stops that agent passing it to a friend for free, so the contract cannot enforce payment the way it can for a scarce good. Publishers can also overstate `C`, there is no proof they did the work themselves rather than copying it, and the whole thing only pays off when several agents want the *same* task, which may be rarer than it sounds. Finally, most useful agent work (research, summaries, judgements) is not deterministic, and for that work "is this result wrong?" has no mechanical answer.

## Which objections the design answers, and which it does not

| Objection | Answer |
|---|---|
| Holders can leak the result | Partly answered. Every holder is paid a rebate each time a new buyer joins, so every holder loses money by leaking. That is an incentive, not enforcement. |
| Publisher inflates `C` | Answered by rule 6: a cheaper competing entry takes the buyers. A buyer also never pays more than its own recompute cost, because it can always compute instead. |
| Publisher copied the result | Not answered. The contract rewards whoever publishes first with a bond; it does not prove authorship. |
| Wrong or poisoned result | Answered for deterministic tasks by rules 7 to 9. |
| Non-deterministic work | Answered in part. The scripted market uses only tasks a verifier can recompute. `sim/judge.mjs` shows the same contract ruling on written briefs with a committee of three models on NEAR AI Cloud, each answer signed by NEAR AI. Model judgement can be wrong; the majority rule limits one bad judge, not three. |
| The verifier is one trusted account | Answered in part. Rulings need a majority of a verifier committee, verifiers are paid only when they vote with the outcome, and an undecided challenge lapses. Not answered: the committee is fixed at deployment and is not bonded, so a colluding majority can still rule wrongly. |
| Publisher takes payment and never serves the bytes | Handled as a challenge: the verifiers ask for the bytes, and no bytes matching the hash means they uphold it. |

## What an agent can and cannot do with its key

Each agent is a sub-account (`buyer-7.<parent>`, `seller-2.<parent>`). The agent process holds a **function-call access key** limited to the Splitback contract. With it the agent can publish, join, claim, challenge and withdraw. A verifier agent's key can only vote and withdraw. It cannot transfer NEAR, cannot call the token contract, and cannot add keys.

- The human funds an agent by calling `ft_transfer_call` on the token with the agent's account as the message. The agent's whole budget is that prepaid balance.
- `withdraw` sends tokens to the agent's own account, where the agent's key cannot move them. Only the human, who holds the full-access key, can.
