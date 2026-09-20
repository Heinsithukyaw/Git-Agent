---
name: Agent command
about: Ask the agent to do something. The first line must be the command.
title: '/agent why '
---

/agent why lodash

<!--
The line above is the command, and it must stay the first line — the agent reads
the body and parses the first line that has content. Everything else in this
body is ignored, so you can add notes below it.

The verb must be one of:

  /agent why <pkg>          look up the stored decision          no model
  /agent what-changed       what moved since the last run       no model
  /agent bump <pkg>         open a pull request                 no model
  /agent verify <pr>        run the suite against a patch       no model
  /agent wrong <pkg>        record that a decision was wrong    no model
  /agent pause | resume     toggle the schedule                 no model
  /agent explain <GHSA-…>   argue from the decision record      uses a model

<pkg> must be a name in data/stack.json. Anything else is rejected by the
grammar, not by a model — free text never becomes a command.

Only the repository owner, a member, or a collaborator may issue a command. On a
public repository anyone can comment, so a stranger gets no reply at all.
-->
