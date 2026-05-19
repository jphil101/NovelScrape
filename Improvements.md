~~1. Add intelligent parsing for un-translated terms. E.g., if it's a Murim novel, and the language is guessed to be Korean then Jeukcheon = Red sky or "Crimson Heaven" to be more apt with the novel setting. Heukcheon = "Dark Heaven". Similar translation. Once a certain term is translated, lock it in the DB - must be consistent if same term is encountered. I guess initial translation will need LLM support. Primary roles are language detection and genre-appropriate translation (Generic translation unacceptable)~~ **[COMPLETED]**

~~2. Add more intelligent parsing for gender guessing. Should be a combo of character database values (if available) + in-context gender.~~ **[COMPLETED]**

~~3. Commmon error with such novel translations is subject - object switch e.g., it might say "You are" instead of "I am" or a wild switch like that. Need to fix as much as possible - context-appropriate parsing needed.~~ **[COMPLETED]**

~~4. Reload still leads to chapter 0 being displayed instead of whatever chapter the user was on. Needs fixing.~~ **[COMPLETED]**