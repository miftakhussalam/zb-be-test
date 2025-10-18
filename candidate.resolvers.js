async function UpdateCandidate(
  parent,
  args,
  context
) {
  const {
    _id,
    candidate_input,
    lang,
    new_desired_program,
    is_from_admission_form,
    is_prevent_resend_notif,
    is_save_identity_student,
    is_minor_student,
  } = args;

  // REFACTOR START: get user id from context
  const getUserIdFromContext = () => {
    const tokenUser = String(context?.req?.headers?.authorization || '').replace('Bearer ', '').replace(/"/g, '')
    const userId = tokenUser && tokenUser !== 'undefined' ? common.getUserId(tokenUser) : null;
    return userId;
  }

  let userId = getUserIdFromContext();
  // REFACTOR END: get user id from context

  // *************** find candidate first before update
  const candidateBeforeUpdate = await CandidateModel.findById(_id).select('iban payment_supports parents').lean();

  if (candidate_input.school) {
    candidate_input.school = String(candidate_input.school).toUpperCase();
  }
  if (candidate_input.campus) {
    candidate_input.campus = String(candidate_input.campus).toUpperCase();
  }

  if (candidate_input.civility) {
    if (candidate_input.civility === 'neutral') {
      candidate_input.sex = 'N';
    } else {
      candidate_input.sex = candidate_input.civility === 'MR' ? 'M' : 'F';
    }
  }

  if (candidate_input.parents && candidate_input.parents.length) {
    for (let parent of candidate_input.parents) {
      if (parent.iban && parent.bic && parent.account_holder_name) {
        const ibanHistory = await IbanHistoryModel.create({
          candidate_id: _id,
          iban: parent.iban,
          bic: parent.bic,
          account_holder_name: parent.account_holder_name,
          financial_support_first_name: parent.name,
          financial_support_last_name: parent.family_name,
        });

        try {
          await CandidateUtility.validateIbanBicCandidate(parent.iban, parent.bic);
          await IbanHistoryModel.updateOne({ _id: ibanHistory._id }, { $set: { message: 'success' } });
        } catch (error) {
          await IbanHistoryModel.updateOne({ _id: ibanHistory._id }, { $set: { message: error } });

          throw new ApolloError(error);
        }
      }
    }
  }

  if (candidate_input.tag_ids === null) {
    candidate_input.tag_ids = [];
  }

  // validate iban & bic candidate
  if (candidate_input.iban && candidate_input.bic && candidate_input.account_holder_name) {
    const ibanHistory = await IbanHistoryModel.create({
      candidate_id: _id,
      iban: candidate_input.iban,
      bic: candidate_input.bic,
      account_holder_name: candidate_input.account_holder_name,
    });

    try {
      // *************** check iban input is valid
      await CandidateUtility.validateIbanBicCandidate(candidate_input.iban, candidate_input.bic);

      // *************** udpate the iban history with massage is success
      await IbanHistoryModel.updateOne({ _id: ibanHistory._id }, { $set: { message: 'success' } });
    } catch (error) {
      // *************** udpate the iban history with massage is error
      await IbanHistoryModel.updateOne({ _id: ibanHistory._id }, { $set: { message: error } });

      throw new ApolloError(error);
    }
  }

  if (candidate_input.payment_supports && candidate_input.payment_supports.length) {
    for (let payment_support of candidate_input.payment_supports) {
      if (payment_support.iban && payment_support.bic && payment_support.account_holder_name) {
        const ibanHistory = await IbanHistoryModel.create({
          candidate_id: _id,
          iban: payment_support.iban,
          bic: payment_support.bic,
          account_holder_name: payment_support.account_holder_name,
          financial_support_first_name: payment_support.name,
          financial_support_last_name: payment_support.family_name,
        });

        try {
          // *************** check iban input is valid
          await CandidateUtility.validateIbanBicCandidate(payment_support.iban, payment_support.bic);

          // *************** udpate the iban history with massage is success
          await IbanHistoryModel.updateOne({ _id: ibanHistory._id }, { $set: { message: 'success' } });
        } catch (error) {
          // *************** udpate the iban history with massage is error
          await IbanHistoryModel.updateOne({ _id: ibanHistory._id }, { $set: { message: error } });

          throw new ApolloError(error);
        }
      }
    }
  }

  // *************** if data candidate before update is exist
  if (candidateBeforeUpdate) {
    // *************** if iban in student is different from input
    if (
      (candidate_input.iban || (!candidate_input.iban && candidate_input.iban === '')) &&
      candidateBeforeUpdate.iban &&
      candidateBeforeUpdate.iban !== candidate_input.iban
    ) {
      // *************** create iban history update
      await IbanHistoryUpdateModel.create({
        candidate_id: _id,
        iban: candidate_input.iban,
        iban_before_update: candidateBeforeUpdate.iban,
        user_who_update_id: userId,
      });
    }

    // *************** if iban in payment supports is different from input, then set create history iban
    if (
      candidateBeforeUpdate.payment_supports &&
      candidateBeforeUpdate.payment_supports.length &&
      candidate_input &&
      candidate_input.payment_supports &&
      candidate_input.payment_supports.length
    ) {
      for (const paymentSupportBeforeUpdate of candidateBeforeUpdate.payment_supports) {
        // *************** check iban in payment support is different from input
        let paymentSupportIbanData = candidate_input.payment_supports.find(
          (payment_support) =>
            String(paymentSupportBeforeUpdate._id) === String(payment_support._id) &&
            paymentSupportBeforeUpdate.iban &&
            payment_support.iban !== paymentSupportBeforeUpdate.iban
        );

        // *************** if iban is different
        if (paymentSupportIbanData) {
          // *************** create iban history update
          await IbanHistoryUpdateModel.create({
            candidate_id: _id,
            iban: paymentSupportIbanData.iban,
            iban_before_update: paymentSupportBeforeUpdate.iban,
            user_who_update_id: userId,
            financial_support_first_name: paymentSupportIbanData.name,
            financial_support_last_name: paymentSupportIbanData.family_name,
          });
        }
      }
    }

    // *************** if iban in payment supports is empty from input, create history iban deleted
    if (
      candidateBeforeUpdate &&
      candidateBeforeUpdate.parents &&
      candidateBeforeUpdate.parents.length &&
      candidate_input.parents &&
      candidate_input.parents.length
    ) {
      // *************** loop per parents before update
      for (const parentBeforeUpdate of candidateBeforeUpdate.parents) {
        // *************** check if iban parents is different from input
        let parentIbanData = candidate_input.parents.find(
          (parent) =>
            String(parentBeforeUpdate._id) === String(parent._id) && parentBeforeUpdate.iban && parent.iban !== parentBeforeUpdate.iban
        );

        // *************** if parent data iban different
        if (parentIbanData) {
          // *************** create iban history update
          await IbanHistoryUpdateModel.create({
            candidate_id: _id,
            iban: parentIbanData.iban,
            iban_before_update: parentBeforeUpdate.iban,
            user_who_update_id: userId,
            financial_support_first_name: parentIbanData.name,
            financial_support_last_name: parentIbanData.family_name,
          });
        }
      }
    }
  }

  const nowTime = moment.utc();
  const oldCandidate = await CandidateModel.findById(_id);

  // ******************* check if unique_id is exist in legal representative, if exist, then use old representative, otherwise create new using UUID
  if (candidate_input.legal_representative && !candidate_input.legal_representative.unique_id) {
    candidate_input.legal_representative.unique_id =
      oldCandidate.legal_representative && oldCandidate.legal_representative.unique_id
        ? oldCandidate.legal_representative.unique_id
        : common.create_UUID();
  }

  // ******************* check candidate if have civility not exist, then use parental link to add civility
  if (
    candidate_input.legal_representative &&
    !candidate_input.legal_representative.civility &&
    candidate_input.legal_representative.parental_link
  ) {
    const relations = ['father', 'grandfather', 'uncle'];
    const parentalLink =
      candidate_input.legal_representative && candidate_input.legal_representative.parental_link
        ? candidate_input.legal_representative.parental_link
        : '';
    candidate_input.legal_representative.civility = parentalLink === 'other' ? '' : relations.includes(parentalLink) ? 'MR' : 'MRS';
  }

  // ******************* make last name legal representative to uppercase
  if (candidate_input.legal_representative && candidate_input.legal_representative.last_name) {
    candidate_input.legal_representative.last_name = candidate_input.legal_representative.last_name.toUpperCase();
  }

  //failsafe if candidate finance no set up yet on form filling
  if (
    !candidate_input.finance &&
    !oldCandidate.finance &&
    oldCandidate.selected_payment_plan &&
    oldCandidate.selected_payment_plan.payment_mode_id
  ) {
    if (
      (candidate_input.payment_supports && candidate_input.payment_supports.length) ||
      (oldCandidate.payment_supports && oldCandidate.payment_supports.length)
    ) {
      candidate_input.finance = 'family';
    } else {
      candidate_input.finance = 'my_self';
    }
  }

  let oldSelectedPaymentPlanData = JSON.parse(JSON.stringify(oldCandidate.selected_payment_plan));
  oldSelectedPaymentPlanData.payment_date = oldSelectedPaymentPlanData.payment_date.map((term) => {
    delete term._id;
    return term;
  });

  // ************** add condition if candidate old email is different from input and candidate is registered
  if (
    oldCandidate &&
    oldCandidate.user_id &&
    oldCandidate.candidate_admission_status &&
    oldCandidate.candidate_admission_status === 'registered' &&
    candidate_input &&
    ((oldCandidate.email && candidate_input.email && oldCandidate.email !== candidate_input.email) ||
      (!oldCandidate.email && candidate_input.email))
  ) {
    // ************** if different, then remove the recovery code in user
    await UserModel.updateOne(
      { _id: oldCandidate.user_id },
      {
        $set: {
          email: candidate_input.email,
          recovery_code: '',
        },
      },
      { new: true }
    );
    // ************** update candidate email so the notificatio can get user id based on new email instead of old email
    await CandidateModel.updateOne({ _id: oldCandidate._id }, { $set: { email: candidate_input.email } });

    // ************** send notif stud reg n1 for set the recovery code again
    await CandidateUtility.Send_STUD_REG_N1(oldCandidate._id, lang);
  }

  if (
    candidate_input &&
    oldSelectedPaymentPlanData &&
    oldSelectedPaymentPlanData.total_amount &&
    oldSelectedPaymentPlanData.total_amount > 0 &&
    candidate_input.selected_payment_plan &&
    typeof oldSelectedPaymentPlanData === 'object' &&
    typeof candidate_input.selected_payment_plan === 'object'
  ) {
    for (const [key, value] of Object.entries(candidate_input.selected_payment_plan)) {
      if (String(candidate_input.selected_payment_plan[key]) !== String(oldSelectedPaymentPlanData[key])) {
        throw new ApolloError('payment plan is already selected!');
      }
    }
  }

  if (!userId) userId = oldCandidate.user_id; //in case this mutation called without auth token

  if (!oldCandidate.admission_process_id) {
    if (is_from_admission_form || (candidate_input.payment_method && candidate_input.payment_method !== oldCandidate.payment_method)) {
      await CandidateUtility.validateCandidateInput(candidate_input, oldCandidate);

      if (
        ['registered', 'engaged', 'resigned_after_engaged', 'resigned_after_registered'].includes(oldCandidate.candidate_admission_status)
      ) {
        const current_step = await CandidateUtility.getCandidateCurrentStep(oldCandidate);
        if (!candidate_input.payment_method && current_step !== 'down_payment') {
          throw new ApolloError('Cannot edit data, candidate already signed school contract!');
        }
      }
    }
  }

  // To update candidate status, and validation on readmission assignment table
  if (
    (candidate_input.candidate_admission_status &&
      oldCandidate.candidate_admission_status === 'registered' &&
      candidate_input.candidate_admission_status === 'resigned') ||
    (candidate_input.candidate_admission_status &&
      oldCandidate.candidate_admission_status === 'registered' &&
      candidate_input.candidate_admission_status === 'resigned_after_engaged') ||
    (candidate_input.candidate_admission_status &&
      oldCandidate.candidate_admission_status === 'registered' &&
      candidate_input.candidate_admission_status === 'resigned_after_registered') ||
    (candidate_input.candidate_admission_status &&
      oldCandidate.candidate_admission_status === 'registered' &&
      candidate_input.candidate_admission_status === 'no_show') ||
    (candidate_input.candidate_admission_status &&
      oldCandidate.candidate_admission_status === 'registered' &&
      candidate_input.candidate_admission_status === 'resignation_missing_prerequisites') ||
    (candidate_input.candidate_admission_status &&
      oldCandidate.candidate_admission_status === 'registered' &&
      candidate_input.candidate_admission_status === 'resign_after_school_begins') ||
    (candidate_input.candidate_admission_status &&
      oldCandidate.candidate_admission_status === 'registered' &&
      candidate_input.candidate_admission_status === 'report_inscription')
  ) {
    const candidateFound = await CandidateModel.findById(oldCandidate._id).select('student_id').lean();
    const otherCandidateSameStudent = await CandidateModel.find({ student_id: candidateFound.student_id }).select('_id').lean();

    let candidateIds = [];
    if (otherCandidateSameStudent.length === 0) {
      candidateIds.push(oldCandidate._id);
    } else {
      otherCandidateSameStudent.map((candidateId) => candidateIds.push(candidateId._id));
    }

    await CandidateModel.updateMany(
      { _id: { $in: candidateIds }, readmission_status: 'assignment_table' },
      {
        $set: {
          is_student_resigned: true,
        },
      }
    );
  }

  if (
    (candidate_input.candidate_admission_status &&
      oldCandidate.candidate_admission_status === 'resigned' &&
      candidate_input.candidate_admission_status === 'registered') ||
    (candidate_input.candidate_admission_status &&
      oldCandidate.candidate_admission_status === 'resigned_after_engaged' &&
      candidate_input.candidate_admission_status === 'registered') ||
    (candidate_input.candidate_admission_status &&
      oldCandidate.candidate_admission_status === 'resigned_after_registered' &&
      candidate_input.candidate_admission_status === 'registered') ||
    (candidate_input.candidate_admission_status &&
      oldCandidate.candidate_admission_status === 'no_show' &&
      candidate_input.candidate_admission_status === 'registered') ||
    (candidate_input.candidate_admission_status &&
      oldCandidate.candidate_admission_status === 'resignation_missing_prerequisites' &&
      candidate_input.candidate_admission_status === 'registered') ||
    (candidate_input.candidate_admission_status &&
      oldCandidate.candidate_admission_status === 'resign_after_school_begins' &&
      candidate_input.candidate_admission_status === 'registered') ||
    (candidate_input.candidate_admission_status &&
      oldCandidate.candidate_admission_status === 'report_inscription' &&
      candidate_input.candidate_admission_status === 'registered')
  ) {
    const candidateFound = await CandidateModel.findById(oldCandidate._id).select('student_id').lean();
    const otherCandidateSameStudent = await CandidateModel.find({ student_id: candidateFound.student_id }).select('_id').lean();

    let candidateIds = [];
    if (otherCandidateSameStudent.length === 0) {
      candidateIds.push(oldCandidate._id);
    } else {
      otherCandidateSameStudent.map((candidateId) => candidateIds.push(candidateId._id));
    }

    await CandidateModel.updateMany(
      { _id: { $in: candidateIds }, readmission_status: 'assignment_table' },
      {
        $set: {
          is_student_resigned: false,
        },
      }
    );
  }

  // start process change step status for continuous fomation student
  const typeOfFormation = await TypeOfFormationModel.findById(oldCandidate.type_of_formation_id);
  const continuousTypeOfFormation = [
    'continuous',
    'continuous_total_funding',
    'continuous_partial_funding',
    'continuous_personal_funding',
    'continuous_contract_pro',
  ];
  let admissionProcess = null;

  if (oldCandidate.admission_process_id) {
    // admissionProcess = await StudentAdmissionProcessModel.findById(oldCandidate.admission_process_id)
    admissionProcess = await FormProcessModel.findById(oldCandidate.admission_process_id)
      .populate([
        {
          path: 'steps form_builder_id',
          populate: {
            path: 'steps',
          },
        },
        {
          path: 'candidate_id',
          populate: {
            path: 'continuous_formation_manager_id',
          },
        },
      ])
      .exec();
    // handle input payment_method cash to update step down payment mode
    if (candidate_input.payment_method === 'cash') {
      if (admissionProcess && admissionProcess.steps && admissionProcess.steps.length) {
        const downPaymentStep = admissionProcess.steps.find((step) => step.step_type === 'down_payment_mode');
        if (downPaymentStep) {
          // await StudentAdmissionProcessStepModel.findByIdAndUpdate(downPaymentStep._id, { $set: { step_status: 'accept' } });
          await FormProcessStepModel.findByIdAndUpdate(downPaymentStep._id, { $set: { step_status: 'accept' } });
          await CandidateUtility.updateCandidateAdmissionStatusFromAdmissionProcessStep(_id, downPaymentStep._id, context.userId, lang);
          await StudentAdmissionProcessUtilities.validateStatusStepFinalMessage(admissionProcess._id);
        }
      }
    }
  }

  // process to accept step down_payment_mode
  // Accept step down_payment_mode if FE send payment 'no_down_payment'
  if (
    (typeOfFormation &&
      (continuousTypeOfFormation.includes(typeOfFormation.type_of_formation) || oldCandidate.readmission_status === 'readmission_table') &&
      candidate_input.payment_method &&
      candidate_input.payment_method !== oldCandidate.payment_method &&
      !['credit_card', 'sepa', 'transfer', 'check', 'bank'].includes(candidate_input.payment_method)) ||
    candidate_input.payment === 'no_down_payment'
  ) {
    if (admissionProcess && admissionProcess.steps && admissionProcess.steps.length) {
      const downPaymentStep = admissionProcess.steps.find((step) => step.step_type === 'down_payment_mode');
      if (downPaymentStep) {
        // await StudentAdmissionProcessStepModel.findByIdAndUpdate(downPaymentStep._id, { $set: { step_status: 'accept' } });
        await FormProcessStepModel.findByIdAndUpdate(downPaymentStep._id, { $set: { step_status: 'accept' } });
        await CandidateUtility.updateCandidateAdmissionStatusFromAdmissionProcessStep(_id, downPaymentStep._id, context.userId, lang);
        // ******************* process candidate to register if its type FI
        if (typeOfFormation.type_of_formation === 'classic') {
          await CandidateUtility.proceedRegisteredStudent(_id, lang);
        }
      }
    }
  }

  // process to accept step campus_validation
  if (
    typeOfFormation &&
    (continuousTypeOfFormation.includes(typeOfFormation.type_of_formation) || oldCandidate.readmission_status === 'readmission_table') &&
    candidate_input.program_confirmed &&
    candidate_input.program_confirmed === 'done'
  ) {
    if (admissionProcess && admissionProcess.steps && admissionProcess.steps.length) {
      const campusStep = admissionProcess.steps.find((step) => step.step_type === 'campus_validation');
      if (campusStep) {
        // await StudentAdmissionProcessStepModel.findByIdAndUpdate(campusStep._id, { $set: { step_status: 'accept' } });
        await FormProcessStepModel.findByIdAndUpdate(campusStep._id, { $set: { step_status: 'accept' } });
        await CandidateUtility.updateCandidateAdmissionStatusFromAdmissionProcessStep(_id, campusStep._id, context.userId, lang);
      }
    }
  }

  // process to accept step school contract
  if (
    typeOfFormation &&
    (continuousTypeOfFormation.includes(typeOfFormation.type_of_formation) || oldCandidate.readmission_status === 'readmission_table') &&
    candidate_input.signature &&
    candidate_input.signature === 'done'
  ) {
    if (admissionProcess && admissionProcess.steps && admissionProcess.steps.length) {
      const summaryStep = admissionProcess.steps.find((step) => step.step_type === 'summary');
      if (summaryStep) {
        // await StudentAdmissionProcessStepModel.findByIdAndUpdate(summaryStep._id, { $set: { step_status: 'accept' } }, { new: true });
        await FormProcessStepModel.findByIdAndUpdate(summaryStep._id, { $set: { step_status: 'accept' } }, { new: true });
        await CandidateUtility.updateCandidateAdmissionStatusFromAdmissionProcessStep(_id, summaryStep._id, context.userId, lang);
        await FormProcessModel.findByIdAndUpdate(oldCandidate.admission_process_id, {
          $set: {
            signature_date: {
              date: nowTime.format('DD/MM/YYYY'),
              time: nowTime.format('HH:mm'),
            },
          },
        });

        candidate_input.candidate_sign_date = {
          date: nowTime.format('DD/MM/YYYY'),
          time: nowTime.format('HH:mm'),
        };
        // Update Candidate summaryStep
        const summarySchoolPdf = await StudentAdmissionProcessUtility.generatePDFStep(_id, summaryStep._id, lang);
        candidate_input.school_contract_pdf_link = summarySchoolPdf;
      }
    }
  }

  if (
    candidate_input.payment_method &&
    ['check', 'transfer'].includes(candidate_input.payment_method) &&
    oldCandidate.payment &&
    oldCandidate.payment === 'not_authorized'
  ) {
    candidate_input.payment = 'not_done';
  }

  if (oldCandidate.payment === 'done' && candidate_input.payment === 'pending') {
    candidate_input.payment = oldCandidate.payment;
  }

  if (candidate_input.payment_method && oldCandidate.payment_method === candidate_input.payment_method) {
    candidate_input.payment = oldCandidate.payment;
  }
  if (candidate_input.finance && oldCandidate.finance !== candidate_input.finance && candidate_input.finance === 'my_self') {
    // *************** is_save_identity_student are used in student card to not use iban validation when updating data in student card
    if (oldCandidate.method_of_payment === 'sepa' && !is_save_identity_student) {
      if (!candidate_input.iban || !candidate_input.bic || !candidate_input.account_holder_name) {
        throw new ApolloError('Answer of question is required');
      }
      const checkIban = await IbanHistoryModel.findOne({ candidate_id: oldCandidate._id }).sort({ _id: -1 }).lean();
      if (!checkIban || checkIban.message !== 'success') {
        throw new ApolloError('IBAN not verified');
      }
    }
  }

  // *************** failsafe, empty parent if required data is null
  if (candidate_input.parents && candidate_input.parents.length) {
    const validParentsData = [];
    for (let i = 0; i < candidate_input.parents.length; i++) {
      // ******** separate valid and unvalid data
      if (candidate_input.parents[i].family_name && candidate_input.parents[i].name && candidate_input.parents[i].email) {
        validParentsData.push(candidate_input.parents[i]);
      }
    }
    candidate_input.parents = validParentsData;
  }

  // *************** failsafe, empty payment support if required data is null
  if (candidate_input.payment_supports && candidate_input.payment_supports.length) {
    const validatedPaymentSupportsData = [];
    for (let i = 0; i < candidate_input.payment_supports.length; i++) {
      // ******** separate valid and unvalid data
      if (
        candidate_input.payment_supports[i].family_name &&
        candidate_input.payment_supports[i].name &&
        candidate_input.payment_supports[i].email
      ) {
        validatedPaymentSupportsData.push(candidate_input.payment_supports[i]);
      }
    }
    candidate_input.payment_supports = validatedPaymentSupportsData;
  }

  // ******************* Save history legal representative
  await CandidateUtility.SaveHistoryLegalRepresentative(candidate_input, _id, userId);

  //*********** When cvec_number or ine_number is updated from student card also update it to the cvec form to the cvec_number field and ine_number field of the question and field step
  if (candidate_input.cvec_number || candidate_input.ine_number) {
    if (candidate_input.cvec_number) {
      candidate_input.cvec_number = candidate_input.cvec_number.toUpperCase();
    }

    if (candidate_input.ine_number) {
      candidate_input.ine_number = candidate_input.ine_number.toUpperCase();
    }

    if (oldCandidate.cvec_form_process_id) {
      const cvevFormProcess = await FormProcessModel.findById(oldCandidate.cvec_form_process_id)
        .populate([{ path: 'steps', populate: [{ path: 'segments.questions' }] }])
        .lean();
      if (cvevFormProcess) {
        for (const step of cvevFormProcess.steps) {
          if (step.step_type === 'question_and_field' && step.step_status === 'accept') {
            for (const segment of step.segments) {
              for (const question of segment.questions) {
                if (question.field_type === 'cvec_number' && question.answer.toLowerCase() !== candidate_input.cvec_number.toLowerCase()) {
                  await FormProcessQuestionModel.findByIdAndUpdate(
                    question._id,
                    {
                      $set: {
                        answer: candidate_input.cvec_number,
                      },
                    },
                    {
                      new: true,
                    }
                  );
                } else if (
                  question.field_type === 'ine_number' &&
                  question.answer.toLowerCase() !== candidate_input.ine_number.toLowerCase()
                ) {
                  await FormProcessQuestionModel.findByIdAndUpdate(
                    question._id,
                    {
                      $set: {
                        answer: candidate_input.ine_number,
                      },
                    },
                    {
                      new: true,
                    }
                  );
                }
              }
            }
          }
        }
      }
    } else {
      const formBuilderIds = await FormBuilderModel.distinct('_id', {
        status: 'active',
        template_type: 'one_time_form',
      });

      const cvecFormProcesses = await FormProcessModel.find({
        status: 'active',
        candidate_id: oldCandidate._id,
        form_builder_id: { $in: formBuilderIds },
      })
        .populate([{ path: 'steps', populate: [{ path: 'segments.questions' }] }])
        .lean();

      if (cvecFormProcesses && cvecFormProcesses.length) {
        for (const cvecFormProcess of cvecFormProcesses) {
          for (const step of cvecFormProcess.steps) {
            if (step.step_type === 'question_and_field' && step.step_status === 'accept') {
              for (const segment of step.segments) {
                for (const question of segment.questions) {
                  if (
                    question.field_type === 'cvec_number' &&
                    question.answer.toLowerCase() !== candidate_input.cvec_number.toLowerCase()
                  ) {
                    await FormProcessQuestionModel.findByIdAndUpdate(
                      question._id,
                      {
                        $set: {
                          answer: candidate_input.cvec_number,
                        },
                      },
                      {
                        new: true,
                      }
                    );
                  } else if (
                    question.field_type === 'ine_number' &&
                    question.answer.toLowerCase() !== candidate_input.ine_number.toLowerCase()
                  ) {
                    await FormProcessQuestionModel.findByIdAndUpdate(
                      question._id,
                      {
                        $set: {
                          answer: candidate_input.ine_number,
                        },
                      },
                      {
                        new: true,
                      }
                    );
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  const updatedCandidate = await CandidateModel.findByIdAndUpdate(_id, { $set: candidate_input }, { new: true });

  // process to accept step scholarship fee
  let oldSelectedPaymentPlan = oldCandidate.selected_payment_plan;
  oldSelectedPaymentPlan.payment_date = oldSelectedPaymentPlan.payment_date.map((term) => {
    delete term._id;
    return term;
  });

  let oldScholarshipStep;
  if (candidate_input.selected_payment_plan && typeof candidate_input.selected_payment_plan === 'object') {
    if (JSON.stringify(oldSelectedPaymentPlan) !== JSON.stringify(candidate_input.selected_payment_plan)) {
      /** Admission FC/Re-Admission */
      if (
        typeOfFormation &&
        (continuousTypeOfFormation.includes(typeOfFormation.type_of_formation) || oldCandidate.readmission_status === 'readmission_table')
      ) {
        if (admissionProcess && admissionProcess.steps && admissionProcess.steps.length) {
          oldScholarshipStep = admissionProcess.steps.find((step) => step.step_type === 'scholarship_fee');
          if (oldScholarshipStep) {
            await FormProcessStepModel.findByIdAndUpdate(oldScholarshipStep._id, { $set: { step_status: 'accept' } }, { new: true });
            await CandidateUtility.updateCandidateAdmissionStatusFromAdmissionProcessStep(
              _id,
              oldScholarshipStep._id,
              context.userId,
              lang
            );
          }
        }
      }

      /** Admission FI */
      if (typeOfFormation && typeOfFormation.type_of_formation === 'classic' && !oldCandidate.readmission_status) {
        let updateFinance = false;
        for (const [key, value] of Object.entries(candidate_input.selected_payment_plan)) {
          if (String(candidate_input.selected_payment_plan[key]) !== String(oldSelectedPaymentPlanData[key])) {
            updateFinance = true;
          }
        }

        if (updateFinance) {
          await CandidateUtility.updateCandidateBilling(oldCandidate, updatedCandidate, context.userId);
        }
      }
    }
  }

  // Generate Billing if scholarship fee is accepted
  // const admissionProcessUpdated = await StudentAdmissionProcessModel.findById(updatedCandidate.admission_process_id)
  const admissionProcessUpdated = await FormProcessModel.findById(updatedCandidate.admission_process_id).populate({ path: 'steps' }).lean();
  if (admissionProcessUpdated && admissionProcessUpdated.steps && admissionProcessUpdated.steps.length) {
    const scholarshipStep = admissionProcessUpdated.steps.find((step) => step.step_type === 'scholarship_fee');
    if (
      typeOfFormation &&
      (continuousTypeOfFormation.includes(typeOfFormation.type_of_formation) || oldCandidate.readmission_status === 'readmission_table') &&
      scholarshipStep &&
      scholarshipStep.step_status === 'accept' &&
      oldScholarshipStep &&
      oldScholarshipStep.step_status !== 'accept'
    ) {
      await CandidateUtility.updateCandidateBilling(oldCandidate, updatedCandidate, context.userId);
    }
  }

  // update user data
  let userCandidate = await UserModel.findById(updatedCandidate.user_id);
  if (userCandidate) {
    userCandidate.user_addresses[0] = {
      address: updatedCandidate.address,
      postal_code: updatedCandidate.post_code,
      country: updatedCandidate.country,
      city: updatedCandidate.city,
      department: updatedCandidate.department,
      region: updatedCandidate.region,
    };
  }

  await UserModel.findByIdAndUpdate(updatedCandidate.user_id, {
    $set: {
      last_name: updatedCandidate.last_name,
      first_name: updatedCandidate.first_name,
      civility: updatedCandidate.civility,
      sex: updatedCandidate.civility === 'neutral' ? 'N' : updatedCandidate.sex,
      user_addresses: (userCandidate && userCandidate.user_addresses) || undefined,
      email: updatedCandidate.email,
      portable_phone: updatedCandidate.telephone,
      office_phone: updatedCandidate.fixed_phone,
    },
  });

  await CandidateHistoryUtility.createNewCandidateHistory(_id, userId, 'update_candidate');

  if (candidate_input.student_mentor_id && updatedCandidate.student_mentor_id) {
    await StudentModel.updateOne({ _id: updatedCandidate.student_mentor_id }, { $set: { is_candidate_mentor: true } });
  }

  const bulkUpdateCandidateQuery = [];
  let oldAdmissionMemberId;

  if (candidate_input.admission_member_id && String(oldCandidate.admission_member_id) !== String(updatedCandidate.admission_member_id)) {
    oldAdmissionMemberId = oldCandidate.admission_member_id;
    if (!userId) {
      await CandidateModel.updateOne({ _id }, { $set: oldCandidate });

      throw new AuthenticationError('Authorization header is missing');
    }

    bulkUpdateCandidateQuery.push(
      {
        updateOne: {
          filter: {
            _id,
            'admission_member_histories.admission_member_status': 'active',
            'admission_member_histories.admission_member_id': mongoose.Types.ObjectId(oldCandidate.admission_member_id),
          },
          update: {
            $set: {
              'admission_member_histories.$.admission_member_status': 'not_active',
              'admission_member_histories.$.deactivation_date ': nowTime.format('DD/MM/YYY'),
              'admission_member_histories.$.deactivation_time': nowTime.format('HH:mm'),
            },
          },
        },
      },
      {
        updateOne: {
          filter: { _id },
          update: {
            $push: {
              admission_member_histories: {
                admission_member_id: candidate_input.admission_member_id,
                activation_date: nowTime.format('DD/MM/YYYY'),
                activation_time: nowTime.format('HH:mm'),
              },
            },
          },
        },
      }
    );

    await CandidateHistoryUtility.createNewCandidateHistory(
      _id,
      userId,
      'update_candidate_admission_member',
      `Admission member updated from ${oldCandidate.admission_member_id} to ${updatedCandidate.admission_member_id}`
    );

    // *************** send to new admission member
    await CandidateUtility.send_CANDIDATE_N2([updatedCandidate], lang, userId, [null, ''].includes(oldCandidate.admission_member_id));

    if (oldCandidate.admission_member_id) {
      // *************** send to old admission member
      await CandidateUtility.send_CANDIDATE_N6([oldCandidate], lang, userId);
    }
  }

  if (candidate_input.student_mentor_id && String(oldCandidate.student_mentor_id) !== String(updatedCandidate.student_mentor_id)) {
    if (!userId) {
      await CandidateModel.updateOne({ _id }, { $set: oldCandidate });

      throw new AuthenticationError('Authorization header is missing');
    }

    bulkUpdateCandidateQuery.push(
      {
        updateOne: {
          filter: {
            _id,
            'student_mentor_histories.student_mentor_status': 'active',
            'student_mentor_histories.student_mentor_id': mongoose.Types.ObjectId(oldCandidate.student_mentor_id),
          },
          update: {
            $set: {
              'student_mentor_histories.$.student_mentor_status': 'not_active',
              'student_mentor_histories.$.deactivation_date': nowTime.format('DD/MM/YYY'),
              'student_mentor_histories.$.deactivation_time': nowTime.format('HH:mm'),
            },
          },
        },
      },
      {
        updateOne: {
          filter: { _id },
          update: {
            $push: {
              student_mentor_histories: {
                student_mentor_id: candidate_input.student_mentor_id,
                activation_date: nowTime.format('DD/MM/YYYY'),
                activation_time: nowTime.format('HH:mm'),
              },
            },
          },
        },
      }
    );

    await CandidateHistoryUtility.createNewCandidateHistory(
      _id,
      userId,
      'update_candidate_student_mentor_id',
      `Student mentor updated from ${oldCandidate.student_mentor_id} to ${updatedCandidate.student_mentor_id}`
    );

    if (oldCandidate.student_mentor_id) {
      // *************** send to old mentor
      await CandidateUtility.send_CANDIDATE_N4([oldCandidate], lang, userId);
    }

    // *************** send to new mentor
    await CandidateUtility.send_CANDIDATE_N3([updatedCandidate], lang, userId);
    // *************** send to student
    await CandidateUtility.send_CANDIDATE_N5([updatedCandidate], lang, userId);
  }

  if (candidate_input.campus && String(oldCandidate.campus) !== String(updatedCandidate.campus)) {
    if (!userId) {
      await CandidateModel.updateOne({ _id }, { $set: oldCandidate });

      throw new AuthenticationError('Authorization header is missing');
    }

    await CandidateModel.updateOne({ _id }, { $set: { campus: oldCandidate.campus } });

    bulkUpdateCandidateQuery.push({
      updateOne: {
        filter: {
          _id,
          campus_histories: {
            $not: {
              $elemMatch: {
                campus: candidate_input.campus,
                campus_status: 'pending',
              },
            },
          },
        },
        update: {
          $push: {
            campus_histories: {
              campus: candidate_input.campus,
              campus_status: 'pending',
            },
          },
        },
      },
    });

    await CandidateHistoryUtility.createNewCandidateHistory(
      _id,
      userId,
      'update_candidate_campus',
      `Campus updated from ${oldCandidate.campus} to ${updatedCandidate.campus}`
    );
  }

  if (
    candidate_input.engagement_level &&
    oldCandidate.engagement_level !== 'registered' &&
    updatedCandidate.engagement_level === 'registered'
  ) {
    await CandidateUtility.addRegisteredCandidateAsStudent({ candidate: updatedCandidate, isSentStudRegN1: false, lang });

    if (oldCandidate.candidate_admission_status !== 'resign_after_school_begins')
      await CandidateUtility.send_REGISTRATION_N3(updatedCandidate);

    if (!updatedCandidate.is_registration_recorded) {
      await GeneralDashboardAdmissionUtility.recordCandidateRegistered(updatedCandidate, userId);
    }

    await CandidateHistoryUtility.createNewCandidateHistory(
      _id,
      userId,
      'update_candidate_campus',
      `Candidate ${updatedCandidate._id} registered`
    );
  }

  if (
    candidate_input.candidate_admission_status &&
    oldCandidate.candidate_admission_status !== 'registered' &&
    updatedCandidate.candidate_admission_status === 'registered'
  ) {
    await CandidateUtility.addRegisteredCandidateAsStudent({ candidate: updatedCandidate, lang });

    // *************** Create next candidate for assignment
    const countDocs = await CandidateModel.countDocuments({
      program_status: 'active',
      $or: [{ _id: updatedCandidate._id }, { email: updatedCandidate.email }, { user_id: updatedCandidate.user_id }],
    });

    // *************** If there are no student active for this candidate
    //**************** RA_EDH_0188 Keep create readmission assignment student if not exist in assigment table
    const checkResult = await CandidateUtility.CheckCandidateExistInReadmission(updatedCandidate);
    if (!checkResult) {
      const scholarSeason = await ScholarSeasonModel.findById(updatedCandidate.scholar_season).lean();
      if (scholarSeason) {
        const startDate = moment(scholarSeason.from.date_utc, 'DD/MM/YYYY');
        const finishDate = moment(scholarSeason.to.date_utc, 'DD/MM/YYYY');
        const today = moment().utc();

        if (today.isSameOrAfter(startDate) && today.isSameOrBefore(finishDate)) {
          await CandidateModel.findByIdAndUpdate(updatedCandidate._id, { $set: { program_status: 'active' } });
        }
      }
      await CandidateUtility.createNextCandidateData(updatedCandidate);
    }

    //********** Prevention to check and create whether its already created data in assignment table after registered
    await CandidateUtility.checkAndCreateCandidateAssignmentTable(updatedCandidate._id);

    // Send REGISTRATION_N7 only when type of formation is initial
    if (
      typeOfFormation &&
      !continuousTypeOfFormation.includes(typeOfFormation.type_of_formation) &&
      updatedCandidate.readmission_status !== 'readmission_table'
    ) {
      await CandidateUtility.send_REGISTRATION_N7(updatedCandidate, lang, is_prevent_resend_notif);
    } else if (updatedCandidate.readmission_status === 'readmission_table') {
      // ************** Send READ_REG_N7 when student readmission
      await CandidateUtility.send_READ_REG_N7(updatedCandidate, lang, is_prevent_resend_notif);
    }

    await CandidateModel.findByIdAndUpdate(updatedCandidate._id, {
      $set: {
        registered_at: {
          date: moment.utc().format('DD/MM/YYYY'),
          time: moment.utc().format('HH:mm'),
        },
      },
    });

    if (!updatedCandidate.is_registration_recorded) {
      await GeneralDashboardAdmissionUtility.recordCandidateRegistered(updatedCandidate, userId);
    }

    await CandidateHistoryUtility.createNewCandidateHistory(
      _id,
      userId,
      'update_candidate_campus',
      `Candidate ${updatedCandidate._id} registered`
    );

    if (oldCandidate.candidate_admission_status === 'report_inscription' && updatedCandidate.candidate_admission_status === 'registered') {
      await CandidateUtility.refundTransanctionHistoryOfCandidate(oldCandidate, updatedCandidate, userId);
    }

    //**********Make cvec form_status from closed back to false if status from resigned_after_registered to registered */
    //**********Restore latest cvec form before status closed */
    if (oldCandidate.closed_cvec_form_process_id && oldCandidate.candidate_admission_status === 'resigned_after_registered') {
      await FormProcessModel.findByIdAndUpdate(oldCandidate.closed_cvec_form_process_id, { $set: { is_form_closed: false } });
      await CandidateModel.findByIdAndUpdate(oldCandidate._id, {
        $set: {
          cvec_form_process_id: oldCandidate.closed_cvec_form_process_id,
          closed_cvec_form_process_id: undefined,
        },
      });
    }

    //**********Make admission_document form_status from closed back to false if status from resigned_after_registered to registered */
    //**********Restore latest admission_document form before status closed */
    if (oldCandidate.closed_admission_document_process_id && oldCandidate.candidate_admission_status === 'resigned_after_registered') {
      await FormProcessModel.findByIdAndUpdate(oldCandidate.closed_admission_document_process_id, { $set: { is_form_closed: false } });
      await CandidateModel.findByIdAndUpdate(oldCandidate._id, {
        $set: {
          admission_document_process_id: oldCandidate.closed_admission_document_process_id,
          closed_admission_document_process_id: undefined,
        },
      });
    }
  }

  if (
    updatedCandidate.candidate_admission_status &&
    oldCandidate.candidate_admission_status !== 'engaged' &&
    updatedCandidate.candidate_admission_status === 'engaged' &&
    typeOfFormation &&
    (!continuousTypeOfFormation.includes(typeOfFormation.type_of_formation) || oldCandidate.readmission_status !== 'readmission_table')
  ) {
    if (updatedCandidate.registration_profile) {
      const profileRateCandidate = await ProfileRateModel.findById(mongoose.Types.ObjectId(updatedCandidate.registration_profile));
      if (profileRateCandidate && profileRateCandidate.is_down_payment === 'no') {
        await CandidateModel.findByIdAndUpdate(mongoose.Types.ObjectId(_id), {
          $set: {
            candidate_admission_status: 'registered',
            registered_at: {
              date: moment.utc().format('DD/MM/YYYY'),
              time: moment.utc().format('HH:mm'),
            },
          },
        });
      }
    }
    await CandidateModel.updateOne(
      { _id },
      {
        $set: {
          candidate_sign_date: {
            date: moment.utc().format('DD/MM/YYYY'),
            time: moment.utc().format('HH:mm'),
          },
        },
      }
    );

    if (!oldCandidate.readmission_status) {
      await CandidateUtility.send_FORM_N1(updatedCandidate, lang);
    }
  }

  if (
    candidate_input.candidate_admission_status &&
    oldCandidate.candidate_admission_status !== 'resigned' &&
    updatedCandidate.candidate_admission_status === 'resigned'
  ) {
    await CandidateModel.findByIdAndUpdate(updatedCandidate._id, {
      $set: {
        resigned_at: {
          date: moment.utc().format('DD/MM/YYYY'),
          time: moment.utc().format('HH:mm'),
        },
      },
    });
  }

  if (
    candidate_input.candidate_admission_status &&
    oldCandidate.candidate_admission_status !== 'resigned_after_engaged' &&
    updatedCandidate.candidate_admission_status === 'resigned_after_engaged'
  ) {
    await CandidateModel.findByIdAndUpdate(updatedCandidate._id, {
      $set: {
        resigned_after_engaged_at: {
          date: moment.utc().format('DD/MM/YYYY'),
          time: moment.utc().format('HH:mm'),
        },
      },
    });
  }

  if (
    candidate_input.candidate_admission_status &&
    oldCandidate.candidate_admission_status !== 'resigned_after_registered' &&
    updatedCandidate.candidate_admission_status === 'resigned_after_registered'
  ) {
    await CandidateModel.findByIdAndUpdate(updatedCandidate._id, {
      $set: {
        resigned_after_registered_at: {
          date: moment.utc().format('DD/MM/YYYY'),
          time: moment.utc().format('HH:mm'),
        },
      },
    });

    const studentData = await StudentModel.findOne({
      candidate_id: updatedCandidate._id,
    });

    // update other mails on microsoft account
    if (studentData.microsoft_email && studentData.microsoft_email !== '') {
      let payload = {
        accountEnabled: false,
        mail: studentData.school_mail,
        givenName: studentData.first_name,
        surname: studentData.last_name,
        otherMails: [studentData.email],
        userPrincipalName: studentData.microsoft_email,
      };

      try {
        // temporary comment wait for new token production domain
        // await microsoftService.updateMicrosoftUser(payload)
      } catch (error) {
        // log error
        console.log(error);
      }
    }

    //****** Make CVEC form as closed if have status not started on step status if update candidate admission status from registered to resigned_after_registered*/
    if (oldCandidate.candidate_admission_status === 'registered' && oldCandidate.cvec_form_process_id) {
      const candidateAdmissionDoc = await FormProcessModel.findById(oldCandidate.cvec_form_process_id)
        .select('steps')
        .populate([{ path: 'steps' }])
        .lean();
      if (candidateAdmissionDoc && candidateAdmissionDoc.steps && candidateAdmissionDoc.steps.length) {
        const findInProgressStep = candidateAdmissionDoc.steps.findIndex((step) => step.step_status === 'not_started');
        if (findInProgressStep > -1)
          await FormProcessModel.findByIdAndUpdate(oldCandidate.cvec_form_process_id, { $set: { is_form_closed: true } });
        await CandidateModel.findByIdAndUpdate(oldCandidate._id, {
          $set: {
            cvec_form_process_id: undefined,
            closed_cvec_form_process_id: oldCandidate.cvec_form_process_id,
          },
        });
      }
    }

    //************* Make Admission document form as closed if have status not started on step if update candidate admission status from registered to resigned_after_registered*/
    if (oldCandidate.candidate_admission_status === 'registered' && oldCandidate.admission_document_process_id) {
      const candidateAdmissionDoc = await FormProcessModel.findById(oldCandidate.admission_document_process_id)
        .select('steps')
        .populate([{ path: 'steps' }])
        .lean();
      if (candidateAdmissionDoc && candidateAdmissionDoc.steps && candidateAdmissionDoc.steps.length) {
        const findInProgressStep = candidateAdmissionDoc.steps.findIndex((step) => step.step_status === 'not_started');
        if (findInProgressStep > -1)
          await FormProcessModel.findByIdAndUpdate(oldCandidate.admission_document_process_id, { $set: { is_form_closed: true } });
        await CandidateModel.findByIdAndUpdate(oldCandidate._id, {
          $set: {
            admission_document_process_id: undefined,
            closed_admission_document_process_id: oldCandidate.admission_document_process_id,
          },
        });
      }
    }
  }

  if (
    candidate_input.program_confirmed &&
    oldCandidate.program_confirmed !== 'request_transfer' &&
    updatedCandidate.program_confirmed === 'request_transfer'
  ) {
    await CandidateUtility.send_Transfer_N5(_id, new_desired_program, lang);
    await CandidateUtility.send_Transfer_N6(_id, new_desired_program, lang);
  }

  if (
    candidate_input.candidate_admission_status &&
    oldCandidate.candidate_admission_status !== 'report_inscription' &&
    updatedCandidate.candidate_admission_status === 'report_inscription'
  ) {
    await CandidateUtility.refundTransanctionHistoryOfCandidate(oldCandidate, updatedCandidate, userId);
    await CandidateModel.findByIdAndUpdate(_id, {
      $set: {
        inscription_at: {
          date: moment.utc().format('DD/MM/YYYY'),
          time: moment.utc().format('HH:mm'),
        },
      },
    });
    await CandidateUtility.send_StudentCard_N1(updatedCandidate, lang);
  }

  // Generate date for field bill_validated_at if candidate_admission_status change to bill_validated

  if (oldCandidate.candidate_admission_status !== 'bill_validated' && updatedCandidate.candidate_admission_status === 'bill_validated') {
    await CandidateModel.findByIdAndUpdate(_id, {
      $set: {
        bill_validated_at: {
          date: moment.utc().format('DD/MM/YYYY'),
          time: moment.utc().format('HH:mm'),
        },
      },
    });
  }

  // Generate date for field financement_validated_at if candidate_admission_status change to financement_validated
  if (
    oldCandidate.candidate_admission_status !== 'financement_validated' &&
    updatedCandidate.candidate_admission_status === 'financement_validated'
  ) {
    await CandidateModel.findByIdAndUpdate(_id, {
      $set: {
        financement_validated_at: {
          date: moment.utc().format('DD/MM/YYYY'),
          time: moment.utc().format('HH:mm'),
        },
      },
    });
  }

  // Generate date for field mission_card_validated if candidate_admission_status change to mission_card_validated

  if (
    oldCandidate.candidate_admission_status !== 'mission_card_validated' &&
    updatedCandidate.candidate_admission_status === 'mission_card_validated'
  ) {
    await CandidateModel.findByIdAndUpdate(_id, {
      $set: {
        mission_card_validated_at: {
          date: moment.utc().format('DD/MM/YYYY'),
          time: moment.utc().format('HH:mm'),
        },
      },
    });
  }

  if (oldCandidate.candidate_admission_status !== 'in_scholarship' && updatedCandidate.candidate_admission_status === 'in_scholarship') {
    await CandidateModel.findByIdAndUpdate(_id, {
      $set: {
        in_scholarship_at: {
          date: moment.utc().format('DD/MM/YYYY'),
          time: moment.utc().format('HH:mm'),
        },
      },
    });
  }

  if (
    oldCandidate.candidate_admission_status !== 'resignation_missing_prerequisites' &&
    updatedCandidate.candidate_admission_status === 'resignation_missing_prerequisites'
  ) {
    await CandidateModel.findByIdAndUpdate(_id, {
      $set: {
        resignation_missing_prerequisites_at: {
          date: moment.utc().format('DD/MM/YYYY'),
          time: moment.utc().format('HH:mm'),
        },
      },
    });
  }

  if (oldCandidate.payment === 'pending' && !oldCandidate.payment_method && candidate_input.payment_method) {
    await CandidateModel.findByIdAndUpdate(updatedCandidate._id, {
      $set: {
        payment: 'pending',
      },
    });
  } else if (
    candidate_input.payment_method &&
    oldCandidate.payment_method !== updatedCandidate.payment_method &&
    updatedCandidate.payment !== 'done'
  ) {
    await CandidateModel.findByIdAndUpdate(updatedCandidate._id, {
      $set: {
        payment: 'not_done',
      },
    });

    if (
      typeOfFormation &&
      !continuousTypeOfFormation.includes(typeOfFormation.type_of_formation) &&
      oldCandidate.readmission_status !== 'readmission_table'
    ) {
      await CandidateUtility.send_FORM_N2(updatedCandidate, lang);
    }
  }
  if (bulkUpdateCandidateQuery.length > 0) {
    await CandidateModel.bulkWrite(bulkUpdateCandidateQuery);
  }

  await StudentAdmissionProcessUtility.updateStudentAdmissionProcessBasedOnStudentData(_id);
  if (candidate_input.payment_method === 'cash' && oldCandidate.payment_method !== candidate_input.payment_method) {
    const masterTransaction = await MasterTransactionModel.findOne({
      status: 'active',
      candidate_id: updatedCandidate._id,
      intake_channel: updatedCandidate.intake_channel,
      operation_name: { $in: ['payment_of_dp', 'down_payment'] },
      status_line_dp_term: 'billed',
    })
      .sort({ _id: -1 })
      .lean();
    if (masterTransaction) {
      await MasterTransactionModel.findByIdAndUpdate(masterTransaction._id, {
        $set: {
          nature: 'cash',
          method_of_payment: 'cash',
          status_line_dp_term: 'pending',
        },
      });
      await MasterTransactionUtilities.SaveMasterTransactionHistory(
        masterTransaction, // *************** old master transaction
        '655ed03e608c5a450cea084e', // *************** user 'zetta' id for actor
        'UpdateCandidate', // *************** function name
        'generate_billing_admission' // *************** action
      );
    }
    candidate_input.payment = 'pending';
  }

  // Check signature if change to done
  if (oldCandidate.signature !== 'done' && updatedCandidate.signature === 'done') {
    if (updatedCandidate.billing_id) {
      const billing = await BillingModel.findById(updatedCandidate.billing_id).lean();
      if (billing.amount_billed === 0 && billing.deposit_status === 'paid') {
        const candidateDataUpdated = await CandidateModel.findByIdAndUpdate(
          updatedCandidate._id,
          { $set: { candidate_admission_status: 'registered' } },
          { new: true }
        );

        // *************** Create next candidate for assignment
        //**************** RA_EDH_0188 Keep create readmission assignment student if not exist in assigment table
        const checkResult = await CandidateUtility.CheckCandidateExistInReadmission(updatedCandidate);
        if (!checkResult) {
          const scholarSeason = await ScholarSeasonModel.findById(updatedCandidate.scholar_season).lean();
          if (scholarSeason) {
            const startDate = moment(scholarSeason.from.date_utc, 'DD/MM/YYYY');
            const finishDate = moment(scholarSeason.to.date_utc, 'DD/MM/YYYY');
            const today = moment().utc();

            if (today.isSameOrAfter(startDate) && today.isSameOrBefore(finishDate)) {
              await CandidateModel.findByIdAndUpdate(candidateDataUpdated._id, { $set: { program_status: 'active' } });
            }
          }
          await CandidateUtility.createNextCandidateData(candidateDataUpdated);
        }

        await CandidateUtility.addRegisteredCandidateAsStudent({ candidate: candidateDataUpdated, lang });
        await CandidateUtility.send_REGISTRATION_N7(candidateDataUpdated, lang);
      }
    }
  }

  // Oscar & hubspot update process
  let updatedCandidateNew = await CandidateModel.findById(_id);

  // Update student from candidate
  await CandidateUtility.updateStudentBaseOnCandidate(updatedCandidateNew);

  if (updatedCandidateNew.candidate_admission_status !== candidate_input.candidate_admission_status) {
    delete candidate_input.candidate_admission_status;
  }

  //** remove field payment_supports._id if the value is null */
  if (candidate_input.payment_supports && candidate_input.payment_supports.length) {
    candidate_input.payment_supports.forEach((payment_support) => {
      if (payment_support._id === null) delete payment_support._id;
    });
  }

  if (
    oldCandidate.method_of_payment &&
    updatedCandidate.method_of_payment &&
    oldCandidate.method_of_payment !== updatedCandidate.method_of_payment &&
    updatedCandidate.intake_channel !== null &&
    updatedCandidate.method_of_payment !== 'not_done' &&
    updatedCandidate.billing_id
  ) {
    await BillingModel.findByIdAndUpdate(updatedCandidate.billing_id, { $set: { payment_method: updatedCandidate.method_of_payment } });
    let user_id;
    if (userId) {
      user_id = userId;
    } else {
      user_id = updatedCandidate.user_id;
    }
    await BillingUtility.AddHistoryUpdateBilling(
      updatedCandidate.billing_id,
      'update_payment_method_down_payment',
      'UpdateCandidate',
      user_id
    );
  }
  let stepType;
  updatedCandidateNew = await CandidateModel.findByIdAndUpdate(_id, { $set: candidate_input }, { new: true });
  if (updatedCandidateNew.payment_method !== null && ['done', 'pending'].includes(updatedCandidateNew.payment)) {
    stepType = 'down_payment_mode';
  }
  if (updatedCandidateNew.signature === 'done') {
    stepType = 'step_with_signing_process';
  }
  if (updatedCandidateNew.is_admited === 'done') {
    stepType = 'summary';
  }
  if (updatedCandidateNew.method_of_payment === 'done') {
    stepType = 'modality_payment';
  }
  if (updatedCandidateNew.presonal_information === 'done') {
    stepType = 'question_and_field';
  }
  if (updatedCandidateNew.connection === 'done') {
    stepType = 'campus_validation';
  }
  if (stepType) {
    await CandidateModel.findByIdAndUpdate(_id, {
      $set: {
        last_form_updated: {
          step_type: stepType,
          date_updated: { date: moment.utc().format('DD/MM/YYYY'), time: moment.utc().format('HH:mm') },
        },
      },
    });
  }
  // add validation for split payment

  if (
    updatedCandidateNew.readmission_status !== 'readmission_table' &&
    updatedCandidateNew.signature === 'done' &&
    updatedCandidateNew.signature !== oldCandidate.signature &&
    typeOfFormation &&
    typeOfFormation.type_of_formation === 'classic'
  ) {
    if (updatedCandidateNew.payment === 'done') {
      updatedCandidateNew = await CandidateModel.findByIdAndUpdate(
        _id,
        {
          $set: {
            candidate_admission_status: 'registered',
            registered_at: { date: moment.utc().format('DD/MM/YYYY'), time: moment.utc().format('HH:mm') },
          },
        },
        { new: true }
      );

      if (updatedCandidateNew.candidate_admission_status === 'registered') {
        await CandidateUtility.addRegisteredCandidateAsStudent({ candidate: updatedCandidateNew });

        if (updatedCandidateNew.readmission_status !== 'readmission_table') {
          await CandidateUtility.send_REGISTRATION_N7(updatedCandidateNew);
        }

        if (!updatedCandidateNew.is_registration_recorded) {
          await GeneralDashboardAdmissionUtility.recordCandidateRegistered(updatedCandidateNew, userId);
        }

        await CandidateHistoryUtility.createNewCandidateHistory(
          updatedCandidateNew.billing_id,
          updatedCandidateNew.user_id,
          'update_candidate_campus',
          `Candidate ${updatedCandidate._id} registered`
        );
      }
    }
  }

  /** compare field finance bettwen old and new one */
  if (candidate_input && candidate_input.finance && oldCandidate.finance !== candidate_input.finance) {
    await CandidateUtility.ValidateFinanceGenerated(updatedCandidateNew);
    if (candidate_input && candidate_input.finance && candidate_input.finance === 'family') {
      await BillingUtility.ValidateAndSplitPaymentCandidateFinancialSupport(updatedCandidateNew);
      await MasterTransactionUtilities.GenerateStudentBalanceFI(_id);
    } else if (candidate_input && candidate_input.finance && candidate_input.finance === 'my_self') {
      await MasterTransactionUtilities.GenerateStudentBalanceFI(_id);
    } else if (candidate_input && candidate_input.finance && candidate_input.finance === 'discount') {
      if (typeOfFormation && typeOfFormation.type_of_formation === 'classic') {
        await MasterTransactionUtilities.GenerateStudentBalanceFI(_id);
      }
    }
  }

  //update fs on billing
  if (updatedCandidateNew && updatedCandidateNew.payment_supports.length) {
    await BillingUtility.updateFinancialSupportBilling(updatedCandidateNew);
  }

  // ******** call function GenerateStudentBalance if candidate registered
  if (
    candidate_input.candidate_admission_status &&
    oldCandidate.candidate_admission_status !== 'registered' &&
    updatedCandidateNew.candidate_admission_status === 'registered'
  ) {
    // ******** add form process to param,if there's any
    if (updatedCandidateNew.admission_process_id) {
      await MasterTransactionUtilities.GenerateStudentBalance(_id, updatedCandidateNew.admission_process_id, true);
    } else {
      await MasterTransactionUtilities.GenerateStudentBalance(_id);
    }
  }

  if (
    (candidate_input.candidate_admission_status &&
      oldCandidate.candidate_admission_status !== 'registered' &&
      updatedCandidateNew.candidate_admission_status === 'registered') ||
    (candidate_input.candidate_admission_status &&
      oldCandidate.candidate_admission_status !== 'resigned' &&
      updatedCandidateNew.candidate_admission_status === 'resigned') ||
    (candidate_input.candidate_admission_status &&
      oldCandidate.candidate_admission_status !== 'resigned_after_engaged' &&
      updatedCandidateNew.candidate_admission_status === 'resigned_after_engaged') ||
    (candidate_input.candidate_admission_status &&
      oldCandidate.candidate_admission_status !== 'resigned_after_registered' &&
      updatedCandidateNew.candidate_admission_status === 'resigned_after_registered') ||
    (candidate_input.candidate_admission_status &&
      oldCandidate.candidate_admission_status !== 'admitted' &&
      updatedCandidateNew.candidate_admission_status === 'admitted') ||
    (candidate_input.candidate_admission_status &&
      oldCandidate.candidate_admission_status !== 'admission_in_progress' &&
      updatedCandidateNew.candidate_admission_status === 'admission_in_progress')
  ) {
    if (updatedCandidateNew.oscar_campus_id) {
      await CandidateUtility.changeCandidateStatusInOscarCampus(updatedCandidateNew);
    } else if (updatedCandidateNew.hubspot_deal_id && updatedCandidateNew.hubspot_contact_id) {
      await CandidateUtility.updateCandidateStatusFromHubspot(updatedCandidateNew);
    }
  }

  if (
    candidate_input.candidate_admission_status &&
    candidate_input.candidate_admission_status !== oldCandidate.candidate_admission_status
  ) {
    await CandidateModel.findByIdAndUpdate(_id, {
      $push: {
        status_update_histories: {
          type: is_from_admission_form ? 'platform' : 'user',
          userId: is_from_admission_form ? undefined : context.userId,
          previous_status: oldCandidate.candidate_admission_status,
          next_status: candidate_input.candidate_admission_status,
          datetime: {
            date: moment.utc().format('DD/MM/YYYY'),
            time: moment.utc().format('HH:mm'),
          },
        },
      },
    });
  }

  // ******************* check if is_minor_student is true
  if (is_minor_student && is_minor_student === true) {
    // ******************* validattion to save emancipated minor document
    const rejectEmancipatedDoc = await DocumentModel.findOne({
      _id: oldCandidate.emancipated_document_proof_id,
    }).sort({ _id: -1 });
    if (
      (candidate_input.is_adult === false &&
        (!oldCandidate.is_adult || oldCandidate.is_adult === true) &&
        candidate_input.is_emancipated_minor === true &&
        (!oldCandidate.is_emancipated_minor || oldCandidate.is_emancipated_minor === false)) ||
      (candidate_input.is_adult === oldCandidate.is_adult &&
        candidate_input.is_emancipated_minor === oldCandidate.is_emancipated_minor &&
        rejectEmancipatedDoc &&
        rejectEmancipatedDoc.document_status === 'rejected')
    ) {
      const emancipatedDoc = await DocumentModel.create({
        document_name:
          candidate_input && candidate_input.emancipated_document_proof_original_name
            ? candidate_input.emancipated_document_proof_original_name
            : '',
        s3_file_name:
          candidate_input && candidate_input.emancipated_document_proof_name ? candidate_input.emancipated_document_proof_name : '',
        type_of_document: 'emancipated_document_proof',
        document_generation_type: 'emancipated_document',
        document_status: 'validated',
        candidate_id: _id,
        program_id: updatedCandidateNew.intake_channel,
      });

      // ******************* update candidate to save emancipated doc proof
      if (emancipatedDoc) {
        updatedCandidateNew = await CandidateModel.findByIdAndUpdate(
          updatedCandidateNew._id,
          {
            $set: {
              emancipated_document_proof_id: emancipatedDoc._id,
            },
          },
          {
            new: true,
          }
        );

        // ******************* soft deleted rejected document if candidate have same program
        if (rejectEmancipatedDoc) {
          await DocumentModel.findByIdAndUpdate(
            {
              _id: rejectEmancipatedDoc._id,
              candidate_id: _id,
              program_id: updatedCandidateNew.intake_channel,
              type_of_document: 'emancipated_document_proof',
              document_status: 'rejected',
            },
            {
              $set: {
                status: 'deleted',
              },
            },
            {
              new: true,
            }
          );
        }
      }
    }
  }

  // ******************* check if is_minor_student is false
  if (!is_minor_student && is_minor_student === false) {
    if (
      !candidate_input.is_adult &&
      candidate_input.is_adult === false &&
      oldCandidate.is_adult !== false &&
      !candidate_input.is_emancipated_minor &&
      candidate_input.is_emancipated_minor === false &&
      oldCandidate.is_emancipated_minor !== false
    ) {
      // ******************* send notif Minor_Student_N3
      await CandidateUtility.send_Minor_Student_N3(_id, lang);

      // ******************* update candidate personal information to legal_representative
      updatedCandidateNew = await CandidateModel.findByIdAndUpdate(updatedCandidateNew._id, {
        $set: {
          personal_information: 'legal_representative',
        },
      });

      // ******************* validation if email in legal representative is same or not with candidate email
      if (candidate_input.legal_representative && candidate_input.legal_representative.email === updatedCandidateNew.email) {
        throw new Error('legal representative cannot have same email with candidate');
      }

      // ******************* update candidate to add legal representative
      const relations = ['father', 'grandfather', 'uncle'];
      const parentalLink =
        candidate_input.legal_representative && candidate_input.legal_representative.parental_link
          ? candidate_input.legal_representative.parental_link
          : '';
      const civilityParentalLink = parentalLink === 'other' ? '' : relations.includes(parentalLink) ? 'MR' : 'MRS';

      // ******************* update candidate to add legal representative
      updatedCandidateNew = await CandidateModel.findByIdAndUpdate(
        updatedCandidateNew._id,
        {
          $set: {
            legal_representative: {
              unique_id: candidate_input.legal_representative.unique_id,
              civility:
                candidate_input.legal_representative && candidate_input.legal_representative.civility
                  ? candidate_input.legal_representative.civility
                  : '',
              first_name:
                candidate_input.legal_representative && candidate_input.legal_representative.first_name
                  ? candidate_input.legal_representative.first_name
                  : '',
              last_name:
                candidate_input.legal_representative && candidate_input.legal_representative.last_name
                  ? candidate_input.legal_representative.last_name
                  : '',
              email:
                candidate_input.legal_representative && candidate_input.legal_representative.email
                  ? candidate_input.legal_representative.email
                  : '',
              phone_number:
                candidate_input.legal_representative && candidate_input.legal_representative.phone_number
                  ? candidate_input.legal_representative.phone_number
                  : '',
              parental_link:
                candidate_input.legal_representative && candidate_input.legal_representative.parental_link
                  ? candidate_input.legal_representative.parental_link
                  : '',
              address:
                candidate_input.legal_representative && candidate_input.legal_representative.address
                  ? candidate_input.legal_representative.address
                  : '',
              postal_code:
                candidate_input.legal_representative && candidate_input.legal_representative.postal_code
                  ? candidate_input.legal_representative.postal_code
                  : '',
              city:
                candidate_input.legal_representative && candidate_input.legal_representative.city
                  ? candidate_input.legal_representative.city
                  : '',
            },
          },
        },
        {
          new: true,
        }
      );
    }
  }

  // *************** call util GenerateBillingExportControllingReport
  BillingUtility.GenerateBillingExportControllingReport(updatedCandidateNew._id);

  return await CandidateModel.findById(updatedCandidateNew._id);
}
